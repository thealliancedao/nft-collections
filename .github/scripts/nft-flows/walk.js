
'use strict';
// walk.js — nft-flows walk 1.0 (SPEC-nft-flows.md). Walks ONE collection's watch set over [FROM,TO] against an RPC
// (secret ARCHIVE_RPC for the pruned span; RPC_URL for the public retained span) and archives every matched tx's
// events as write-once raw parts under nfts/raw/<collection>/<FROM>-<TO>/part-NNNNN.json.gz — the SAME part shape as
// tla-flows/raw ({h,x,t,c,e}) so derive.js reads both. Nothing is classified here: raw is truth, derive is opinion.
//
// Two modes, chosen automatically:
//   txsearch — /tx_search?query="wasm._contract_address='<addr>' AND tx.height>=F AND tx.height<=T" per watched address,
//              100/page, asc. Cheap on an indexed node: only matched txs cross the wire. Block times come from /block per
//              distinct height (cached). Used when the node answers the first probe.
//   blocks   — /block + /block_results for every height (archive-walk's loop, concurrency 2): the fallback when the node
//              has no tx index. Expensive; the pace knob matters here.
// PACING (the archive node is a gift — never hammer it): PACE_MS sleep after EVERY node call (default 250), CONC 2 in
// block mode, exponential backoff on any failure, RUN_BUDGET stop-early, and SELF-CHAIN so one dispatch walks the span
// in ≤ CHUNK-block runs. Raw parts are write-once; re-running a range is harmless.
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const zlib  = require('zlib');
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });
const COLLECTION    = String(process.env.COLLECTION || 'pixel-lions');
const ARCHIVE_RPC   = String(process.env.ARCHIVE_RPC || '').replace(/\/+$/, '');
const RPC_URL       = String(process.env.RPC_URL || '').replace(/\/+$/, '');
const RPC           = ARCHIVE_RPC || RPC_URL;
const FROM          = Number(process.env.WALK_FROM || process.argv[2]);
const FINAL         = Number(process.env.FINAL_HEIGHT || 0);
const CHUNK         = Number(process.env.CHUNK_BLOCKS || 300000);
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MIN || 320) * 60000;
const TO_RAW        = process.env.WALK_TO || process.argv[3];
const TO            = TO_RAW ? Number(TO_RAW) : (FINAL ? Math.min(FROM + CHUNK - 1, FINAL) : NaN);
const PACE_MS       = Number(process.env.PACE_MS || 250);
const CONC          = Number(process.env.WALK_CONCURRENCY || 2);
const PART_TXS      = Number(process.env.RAW_PART_TXS || 1500);
const MODE_FORCE    = String(process.env.WALK_MODE || '');            // '', 'txsearch', 'blocks'
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'nft-flows-walk.yml';
const GITHUB_REPO   = process.env.GITHUB_REPO || 'thealliancedao/nft-collections';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const RAW_DIR       = () => `${COLLECTION}/raw/${FROM}-${TO}`;
function fail(m) { console.error('FATAL: ' + m); process.exit(1); }
if (!RPC) fail('no RPC: set ARCHIVE_RPC (secret) or RPC_URL');
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO < FROM) fail('bad range');
if (!GITHUB_TOKEN) fail('GITHUB_TOKEN missing');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpGet(url, t = 25000, hops = 0) {
  return new Promise((res, rej) => {
    const r = (url.startsWith('http:') ? http : https).get(url, { agent: url.startsWith('http:') ? undefined : AGENT, headers: { Accept: 'application/json', 'User-Agent': 'tla-nft-flows-walk/1.0' } }, (x) => {
      if (x.statusCode >= 301 && x.statusCode <= 308 && x.headers.location && hops < 3) {
        x.resume(); clearTimeout(dl);
        const next = new URL(x.headers.location, url).toString();
        return httpGet(next, t, hops + 1).then(res, rej);
      }
      let b = ''; x.on('data', c => b += c); x.on('end', () => { clearTimeout(dl);
        if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
        else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 100)}`)); });
    });
    r.on('error', (e) => { clearTimeout(dl); rej(e); });
    r.setTimeout(t, () => r.destroy(new Error('idle-timeout')));
    const dl = setTimeout(() => r.destroy(new Error('deadline')), t * 2); if (dl.unref) dl.unref();
  });
}
async function rpc(p, label) {
  let last;
  for (let a = 1; a <= 5; a++) { try { const r = await httpGet(RPC + p); await sleep(PACE_MS); return r; } catch (e) { last = e; await sleep(Math.min(30000, 800 * Math.pow(2, a))); } }
  throw new Error(`${label}: ${last && last.message}`);
}
const txHashOf = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase();
// ---------------------------------------------------------------- github (verbatim from tla-flows/archive-walk.js)
function ghReqOnce(method, apiPath, body, accept) {
  return new Promise((resolve, reject) => {
    const GA = new URL(process.env.GITHUB_API || 'https://api.github.com');
    const opts = { hostname: GA.hostname, port: GA.port || undefined, protocol: GA.protocol, path: apiPath, method, headers: { 'User-Agent': 'tla-nft-flows-walk', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = (GA.protocol === 'http:' ? http : https).request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { resolve(d); } } else { const e = new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${String(d).slice(0, 140)}`); e.statusCode = res.statusCode; reject(e); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
// HARDENING (2026-08-06, live kill at chunk 17810676: run died on a GitHub
// call right after part-00022 committed — no manifest, chain broken at 52.6%).
// The RPC side already retried (rpc(), 4×); the GitHub side retried nothing
// but 409. This wrapper retries TRANSIENT failures only — network errors
// (no statusCode), 5xx, 429, and 403 secondary-rate-limit — with exponential
// backoff. 4xx semantics (404 for getJson/exists, 409 for putContent's
// sha-conflict loop) pass through UNCHANGED on the first throw.
const GH_TRIES = Number(process.env.GH_TRANSIENT_TRIES || 5);
async function ghReq(method, apiPath, body, accept) {
  let last;
  for (let a = 1; a <= GH_TRIES; a++) {
    try { return await ghReqOnce(method, apiPath, body, accept); }
    catch (e) {
      last = e;
      const sc = e.statusCode;
      const transient = !sc || sc >= 500 || sc === 429 || (sc === 403 && /rate limit/i.test(e.message));
      if (!transient || a === GH_TRIES) throw e;
      const wait = Math.min(60000, 1500 * Math.pow(2, a - 1));
      console.log(`  \u26a0 GitHub transient (${sc || String(e.message).slice(0, 50)}) \u2014 retry ${a}/${GH_TRIES - 1} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  }
  throw last;
}
async function getJson(p) { try { const d = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw'); return { data: typeof d === 'string' ? JSON.parse(d) : d }; } catch (e) { if (e.statusCode === 404) return { data: null }; throw e; } }
async function exists(p) { try { await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`); return true; } catch (e) { if (e.statusCode === 404) return false; throw e; } }
async function putContent(p, buf, msg) {
  for (let a = 1; a <= 4; a++) {
    let sha = null; try { sha = (await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`)).sha || null; } catch {}
    const body = { message: msg, content: Buffer.from(buf).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    try { return await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/${p}`, body); }
    catch (e) { if (e.statusCode === 409 && a < 4) { await sleep(500 * a); continue; } throw e; }
  }
}
const putJson = (p, obj, msg) => putContent(p, JSON.stringify(obj) + '\n', msg);

// SHARED CLASSIFIER — Marker: <<FLOWS CLASSIFIER v3>>
// v3 (2026-07-31, SPEC-registry-extensions-pnl — evidenced by DeFi_Patriot's
// 8-tx live test matrix, blocks 22,163,785–896, all shapes chainscope-read):
// additive on v2 — every v2 top-level field is emitted UNCHANGED (primary-flow
// selection keeps v2's exact first-match semantics, so the schema-upgrade

async function getBlock(N) { const b = await rpc(`/block?height=${N}`, `block ${N}`); return { time: b.result.block.header.time, txsB64: b.result.block.data.txs || [] }; }
async function getBlockResults(N) { const r = await rpc(`/block_results?height=${N}`, `results ${N}`); return (r.result.txs_results || []).map(t => ({ code: t.code || 0, events: t.events || [] })); }

// ---------------------------------------------------------------- watch set (registry-driven)
const fs = require('fs'); const path = require('path');
const { loadRegistry } = require('./registry.js');
const REG = loadRegistry(process.env.ROOT || process.cwd());
const col = REG.collections[COLLECTION]; if (!col) fail('unknown collection ' + COLLECTION);
const WATCH = new Set([col.collection, ...Object.keys(col.custodians || {}), col.distributor, col.launchpad && col.launchpad.address, ...(col.distribution_wallets || [])].filter(Boolean));
console.log(`nft-flows walk ${COLLECTION} ${FROM} → ${TO} (${TO - FROM + 1} blocks) via [${ARCHIVE_RPC ? 'ARCHIVE_RPC' : 'RPC_URL'}] · watch ${WATCH.size} addresses · pace ${PACE_MS}ms`);
function touches(events) { for (const e of events || []) { if (e.type !== 'wasm') continue; for (const a of e.attributes || []) if (a.key === '_contract_address' && WATCH.has(a.value)) return true; } return false; }

(async () => {
  const t0 = Date.now(); const raw = []; let partN = 0, matched = 0, rawTotal = 0;
  async function flushRaw(final) {
    if (!raw.length || (!final && raw.length < PART_TXS)) return;
    const part = raw.splice(0, raw.length).sort((a, b) => a.h - b.h);
    const p = `${RAW_DIR()}/part-${String(partN).padStart(5, '0')}.json.gz`; partN++;
    if (await exists(p)) { console.log(`  raw ${p}: exists — write-once, skipping`); return; }
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(part)), { level: 9 });
    await putContent(p, gz, `nft-flows walk ${COLLECTION} raw ${FROM}-${TO} part ${partN - 1} (${part.length} txs)`);
    rawTotal += part.length; console.log(`  raw ${p}: ${part.length} txs, ${(gz.length / 1048576).toFixed(2)}MB`);
  }
  let mode = MODE_FORCE || 'txsearch', walkedTo = FROM - 1, budgetHit = false;
  // ---- txsearch mode: one query per watched address, paginated; a failing probe falls back to blocks
  if (mode === 'txsearch') {
    const seen = new Set(); const timeCache = new Map();
    const timeOf = async (h) => { if (!timeCache.has(h)) timeCache.set(h, (await getBlock(h)).time); return timeCache.get(h); };
    try {
      for (const addr of WATCH) {
        const q = encodeURIComponent(`wasm._contract_address='${addr}' AND tx.height>=${FROM} AND tx.height<=${TO}`);
        for (let page = 1; ; page++) {
          if (Date.now() - t0 > RUN_BUDGET_MS) { budgetHit = true; break; }
          const r = await rpc(`/tx_search?query="${q}"&page=${page}&per_page=100&order_by="asc"`, `tx_search ${addr.slice(0, 12)} p${page}`);
          const txs = (r.result && r.result.txs) || []; const total = Number(r.result && r.result.total_count || 0);
          for (const t of txs) { const x = String(t.hash).toUpperCase(); if (seen.has(x)) continue; seen.add(x); const ev = (t.tx_result && t.tx_result.events) || []; if (!touches(ev)) continue; matched++; raw.push({ h: Number(t.height), x, t: await timeOf(Number(t.height)), c: (t.tx_result && t.tx_result.code) || 0, e: ev }); }
          await flushRaw(false);
          if (page === 1) console.log(`  ${addr.slice(0, 16)}…: ${total} txs indexed in range`);
          if (txs.length < 100 || page * 100 >= total) break;
        }
        if (budgetHit) break;
      }
      walkedTo = budgetHit ? FROM - 1 : TO;   // txsearch is all-or-nothing per range: a budget stop re-walks the range next run (parts are write-once, so no double-archive)
      if (budgetHit) console.log('⏱ budget hit mid-range in txsearch mode — range will be re-dispatched from FROM (raise CHUNK down or PACE up)');
    } catch (e) {
      if (MODE_FORCE) throw e;
      console.warn(`tx_search unavailable (${e.message}) — falling back to block walk`); mode = 'blocks'; raw.length = 0; matched = 0;
    }
  }
  // ---- block mode: archive-walk's loop, narrowed to this collection's watch set, concurrency 2
  if (mode === 'blocks') {
    const inFlight = new Map(); const launch = (h) => { if (h <= TO && !inFlight.has(h)) inFlight.set(h, getBlock(h)); };
    for (let h = FROM; h < FROM + CONC && h <= TO; h++) launch(h);
    let lastLog = Date.now(); let processedTo = FROM - 1;
    for (let N = FROM; N <= TO; N++) {
      if (Date.now() - t0 > RUN_BUDGET_MS) { console.log(`⏱ budget reached at ${N - 1} — publishing the walked span, chaining onward`); budgetHit = true; break; }
      const blk = await inFlight.get(N); inFlight.delete(N); launch(N + CONC);
      if (blk.txsB64.length) { const results = await getBlockResults(N); for (let i = 0; i < blk.txsB64.length; i++) { const res = results[i]; if (!res || !touches(res.events)) continue; matched++; raw.push({ h: N, x: txHashOf(blk.txsB64[i]), t: blk.time, c: res.code, e: res.events }); } await flushRaw(false); }
      processedTo = N;
      if (Date.now() - lastLog > 15000) { console.log(`  at ${N} (${TO - N} to go · ${matched} matched)`); lastLog = Date.now(); }
    }
    walkedTo = processedTo;
  }
  await flushRaw(true);
  const report = { collection: COLLECTION, from: FROM, to: TO, walked_to: walkedTo, mode, matched, raw_txs: rawTotal, parts: partN, rpc: ARCHIVE_RPC ? 'archive' : 'public', pace_ms: PACE_MS, ran_at: new Date().toISOString(), ms: Date.now() - t0 };
  await putJson(`${RAW_DIR()}/report.json`, report, `nft-flows walk ${COLLECTION} ${FROM}-${TO} report (${matched} matched, ${mode})`);
  console.log('report:', JSON.stringify(report));
  // ---- self-chain
  const nextFrom = mode === 'txsearch' && budgetHit ? FROM : walkedTo + 1;
  if (FINAL && nextFrom <= FINAL) {
    const nextTo = Math.min(nextFrom + CHUNK - 1, FINAL);
    console.log(`self-chain: dispatching ${nextFrom} → ${nextTo} (final ${FINAL})`);
    await ghReq('POST', `/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: GITHUB_BRANCH, inputs: { collection: COLLECTION, from_height: String(nextFrom), final_height: String(FINAL), to_height: '' } });
    console.log('self-chain: dispatched.');
  } else console.log('walk complete for this dispatch chain.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
