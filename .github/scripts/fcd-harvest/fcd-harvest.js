// =============================================================================
// fcd-harvest.js — deep-history tx capture from Terra's FCD indexer
// Lives in: tla-core/.github/scripts/fcd-harvest/
// =============================================================================
//
// DISCOVERY (2026-07-08): phoenix-fcd.terra.dev is a FROZEN ARCHIVE — its tx
// index covers chain genesis → ~2025-01-07 (height ~13,736,494) and stopped
// there. Public LCD nodes prune to ~1 week; FCD reaches all the way down.
// Confirmed reachable: the aDAO mint era (Dec 2023 – Jan 2024, heights ~8.1M),
// mint wind-down (send_to_dao batches + change_owner at 8,557,841+), and
// deep governance history.
//
// This Action pages ONE account/contract newest→oldest via
//   /v1/txs?account=<addr>&limit=100&offset=<next>
// and stores the capture in tla-core under archive/fcd/<label>/:
//   part-00001.json … (CHUNK_SIZE trimmed txs per part, oldest-last within
//   the run's ordering — parts are ordered by capture sequence, newest first)
//   state.json  (offset cursor, counts, complete flag — resume + honesty)
//
// TRIMMING (documented, chain-exact for our purposes): each tx keeps
//   txhash, height, timestamp, code, tx.body.messages (decoded msgs incl.
//   funds/sender/contract), and logs-derived wasm + coin events.
// Dropped: signatures, auth_info, raw_log (duplicate of logs), gas fields.
// Nothing analytic is lost; full originals remain fetchable from FCD by hash
// while FCD lives.
//
// RESUMABLE: re-running with the same label continues from state.json's
// offset. MAX_PAGES caps a single run (Actions time limits); state.complete
// only flips true when FCD returns an empty/terminal page.
//
// HARVEST FIRST, DERIVE AFTER: this stores capture only. Mint ledgers,
// governance verification, provenance — separate derive steps read these
// parts later.
//
// Env: GITHUB_TOKEN, GITHUB_REPO (thealliancedao/tla-core), GITHUB_BRANCH,
//      ACCOUNT (contract/wallet to harvest), LABEL (folder name),
//      MAX_PAGES (default 2500), CHUNK_SIZE (default 500),
//      FCD_BASE (default https://phoenix-fcd.terra.dev),
//      PAGE_DELAY_MS (default 1100 — FCD sits behind Cloudflare; 200ms tripped 429/1015 after ~25 pages).
// =============================================================================

'use strict';

const https = require('https');

const FCD_BASE      = process.env.FCD_BASE || 'https://phoenix-fcd.terra.dev';
const ACCOUNT       = process.env.ACCOUNT;
const LABEL         = (process.env.LABEL || '').replace(/[^a-z0-9-_]/gi, '');
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/nft-collections';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const MAX_PAGES     = Number(process.env.MAX_PAGES || 2500);
const CHUNK_SIZE    = Number(process.env.CHUNK_SIZE || 500);
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS || 1100);
const OUT_DIR       = process.env.OUT_DIR || `archive/fcd/${LABEL}`;   // nft-collections: <slug>/archive/fcd/<label> (set by the workflow)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 1 });

function httpGet(url, t = 30000) {
    return new Promise((res, rej) => {
        const r = https.get(url, { agent: AGENT, headers: { Accept: 'application/json', 'User-Agent': 'tla-fcd-harvest/1.0' } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 150)}`)); });
        });
        r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
    });
}
const COOLDOWNS_MS = [65000, 65000, 120000, 120000, 300000]; // Cloudflare 429 windows
async function fcdPage(offset) {
    const url = `${FCD_BASE}/v1/txs?account=${ACCOUNT}&limit=100${offset ? `&offset=${offset}` : ''}`;
    let lastErr, rl = 0;
    for (let a = 0; a < 20; a++) {
        try { return await httpGet(url); }
        catch (e) {
            lastErr = e;
            const rateLimited = /429|1015/.test(e.message);
            if (rateLimited) {
                const wait = COOLDOWNS_MS[Math.min(rl++, COOLDOWNS_MS.length - 1)];
                console.warn(`   🧊 rate-limited (attempt ${a + 1}) — cooling down ${wait / 1000}s…`);
                await sleep(wait);
            } else {
                await sleep(800 * (a + 1));
            }
        }
    }
    throw new Error(`FCD page failed after retries (offset=${offset}): ${lastErr.message}`);
}

// ----------------------------------------------------------------------------- trim
function trimEvents(t) {
    // keep wasm + coin_received/coin_spent + transfer events from logs (per-msg
    // fidelity) — enough for classification, amount extraction, provenance.
    const out = [];
    for (const log of t.logs || []) {
        for (const ev of log.events || []) {
            if (ev.type === 'wasm' || ev.type === 'coin_received' || ev.type === 'coin_spent' || ev.type === 'transfer') {
                out.push({ msg_index: log.msg_index ?? 0, type: ev.type, attributes: ev.attributes });
            }
        }
    }
    return out;
}
function trimTx(t) {
    return {
        txhash: t.txhash, height: Number(t.height), timestamp: t.timestamp,
        code: t.code || 0,
        messages: (t.tx?.body?.messages || []).map(m => ({
            '@type': m['@type'], sender: m.sender, contract: m.contract,
            funds: m.funds && m.funds.length ? m.funds : undefined,
            msg: m.msg,
            // MsgUpdateAdmin etc. carry fields outside msg:
            new_admin: m.new_admin, from_address: m.from_address, to_address: m.to_address, amount: m.amount,
        })),
        events: trimEvents(t),
    };
}

// ----------------------------------------------------------------------------- github
function gh(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'tla-fcd-harvest', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { resolve(d); } } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${d.slice(0, 200)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publishFile(filePath, contentObj, message) {
    // 409-retry is mandatory here: this harvester commits every ~minute, and
    // GitHub's contents API intermittently races its own replication on rapid
    // sequential PUTs to one branch. On 409: re-fetch sha, back off, retry.
    const content = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
    let lastErr;
    for (let a = 0; a < 6; a++) {
        let sha = null;
        try { sha = (await gh('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new file */ }
        const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
        if (sha) body.sha = sha;
        try { return await gh('PUT', apiPath, body); }
        catch (e) {
            lastErr = e;
            if (/409/.test(e.message)) { console.warn(`   ↻ 409 on ${filePath} — re-fetching sha, retry ${a + 1}`); await sleep(2000 + a * 1500); }
            else if (a < 2) { await sleep(1500); }
            else throw e;
        }
    }
    throw new Error(`publish failed after 409 retries: ${filePath} — ${lastErr.message}`);
}
async function tryGetJson(url) { try { return await httpGet(url); } catch { return null; } }
const RAW = (f) => `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUT_DIR}/${f}?t=${Date.now()}`;

// ----------------------------------------------------------------------------- main
async function run() {
    if (!ACCOUNT || !LABEL) throw new Error('ACCOUNT and LABEL are required.');
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing.');
    const startedAt = new Date();
    console.log(`\n🏛  fcd-harvest — ${LABEL} (${ACCOUNT})\n    ${startedAt.toISOString()}  base=${FCD_BASE}\n`);

    // resume state
    let state = await tryGetJson(RAW('state.json')) || {
        label: LABEL, account: ACCOUNT, started_at: startedAt.toISOString(),
        next_offset: null, pages_done: 0, txs_done: 0, parts_done: 0,
        newest_height: null, oldest_height: null, complete: false,
        note: 'FCD archive capture: chain genesis → FCD freeze (~2025-01-07). Trimmed txs (see harvester header). Parts ordered by capture sequence (newest first).',
    };
    if (state.complete) { console.log('   already complete — nothing to do.'); return; }
    if (state.pages_done > 0) console.log(`   resuming: ${state.txs_done} txs in ${state.parts_done} parts, offset=${state.next_offset}`);

    let buffer = [];
    let pagesThisRun = 0;
    let terminal = false;
    let abortReason = null;

    const flush = async (final) => {
        // publish-then-consume: if the publish throws, the buffer and part
        // counter are untouched, so a paused run never records an offset past
        // unstored txs.
        while (buffer.length >= CHUNK_SIZE || (final && buffer.length > 0)) {
            const chunk = buffer.slice(0, CHUNK_SIZE);
            const name = `part-${String(state.parts_done + 1).padStart(5, '0')}.json`;
            await publishFile(`${OUT_DIR}/${name}`, { label: LABEL, account: ACCOUNT, count: chunk.length, height_range: [Math.min(...chunk.map(t => t.height)), Math.max(...chunk.map(t => t.height))], txs: chunk }, `fcd-harvest ${LABEL}: ${name} (${chunk.length} txs)`);
            buffer.splice(0, CHUNK_SIZE);
            state.parts_done += 1;
            console.log(`   💾 ${name} (${chunk.length} txs, heights ${Math.min(...chunk.map(t => t.height))}–${Math.max(...chunk.map(t => t.height))})`);
        }
    };

    while (pagesThisRun < MAX_PAGES && !terminal) {
        let page;
        try { page = await fcdPage(state.next_offset); }
        catch (e) {
            // survive: keep everything fetched so far, persist the cursor, pause.
            abortReason = e.message;
            console.warn(`   ⏸ pausing run: ${e.message}`);
            break;
        }
        try {
        const txs = page?.txs || [];
        if (!txs.length) { terminal = true; break; }
        for (const t of txs) {
            const tt = trimTx(t);
            buffer.push(tt);
            if (state.newest_height == null || tt.height > state.newest_height) state.newest_height = tt.height;
            if (state.oldest_height == null || tt.height < state.oldest_height) state.oldest_height = tt.height;
        }
        state.txs_done += txs.length;
        state.pages_done += 1;
        pagesThisRun += 1;
        const next = page.next ?? null;
        if (next == null || next === state.next_offset) terminal = true;
        state.next_offset = next;
        if (pagesThisRun % 10 === 0) console.log(`   … ${state.txs_done} txs (page ${state.pages_done}, oldest so far ${state.oldest_height})`);
        await flush(false);
        // periodic resumability: persist cursor at clean flush boundaries
        if (buffer.length === 0 && state.pages_done % 25 === 0) {
            state.updated_at = new Date().toISOString();
            state.stop_reason = 'in-progress checkpoint';
            await publishFile(`${OUT_DIR}/state.json`, state, `fcd-harvest ${LABEL}: checkpoint p${state.pages_done}`);
        }
        } catch (e) {
            // publish-path failure (post-retries): pause, don't FATAL — state
            // save below preserves resumability from the last flushed offset.
            abortReason = e.message;
            console.warn(`   ⏸ pausing run (publish path): ${e.message}`);
            break;
        }
        await sleep(PAGE_DELAY_MS);
    }
    try { await flush(true); } catch (e) { console.warn(`   ⚠ final flush failed (${e.message}) — unflushed txs will be re-fetched on resume`); }
    if (buffer.length > 0) {
        // unstored txs remain: saving state now would advance the offset past
        // them. Leave the last checkpoint as the resume point instead.
        console.warn(`   ⏸ PAUSED with ${buffer.length} unstored txs — state NOT saved; resume continues from the last checkpoint`);
        return;
    }

    state.complete = terminal;
    state.updated_at = new Date().toISOString();
    state.stop_reason = terminal ? 'fcd-end (index bottom reached)'
        : abortReason ? `paused on error (${abortReason.slice(0, 120)}) — re-run to continue`
        : `page-cap (${MAX_PAGES} this run) — re-run to continue`;
    await publishFile(`${OUT_DIR}/state.json`, state, `fcd-harvest ${LABEL}: state (${state.txs_done} txs, complete=${state.complete})`);

    console.log(`\n${state.complete ? '✅ COMPLETE' : '⏸ PAUSED (re-run to continue)'} — ${state.txs_done} txs, ${state.parts_done} parts, heights ${state.oldest_height}–${state.newest_height}`);
    // a rate-limit pause is a normal outcome, not a failure — exit 0 so the
    // workflow shows the true state (state.json carries the reason).
}

if (require.main === module) {
    run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
}
module.exports = { trimTx, trimEvents };
