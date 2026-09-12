'use strict';
// org-nft-flows 1.1.0 — FORWARD CAPTURE for ONE collection: Render cron `org-nft-flows-<slug>` (hourly), env COLLECTION=<slug>.
// One service per collection: stop, delete or add a collection without touching the others. Reads the collection's own
// config (nft-collections/<slug>/collection.json capture block + venues.json), walks new blocks from its own cursor,
// and writes only inside its own folder (<slug>/raw/forward, <slug>/ledger, <slug>/nft-flows/heartbeat.json).
// Picks up where the backfill left off; the archive node is never needed again.
//
//   reads  : tla-core/docs/curated/nft-collections.json (registry — the ONLY per-collection input)
//            tla-core/nfts/ledger-cursor.json (global block cursor; first run derives it from each ledger's coverage)
//            tla-core/nfts/adao/snapshots/luna-usd-daily.json (USD at the day)
//   walks  : cursor+1 → head-LAG on RPC_PRIMARY (fallback RPC_FALLBACK), /block + /block_results, concurrency 4,
//            MAX_BLOCKS_PER_RUN cap (a long outage catches up over several runs, never one giant run)
//   writes : tla-core/nfts/raw/<collection>/forward/YYYY-MM-DD.json.gz  — every matched tx's events, same {h,x,t,c,e}
//            shape as the backfill parts (write-once per day file: read-merge-write within the day, keyed by txhash)
//            tla-core/nfts/<collection>/ledger/YYYY/MM.json  — classified records merged by recordKey (never-shrink)
//            tla-core/nfts/<collection>/ledger/index.json    — totals, by_kind, months, coverage += forward range
//            tla-core/nfts/ledger-cursor.json, tla-core/nfts/nft-flows/heartbeat.json
//   LAWS   : one classifier (lib/classify.js is BYTE-IDENTICAL to tla-core/.github/scripts/nft-flows/classify.js —
//            diff-gate on every change); raw before ledger (a tx is archived before it is interpreted); write-once /
//            never-shrink; a failed read never advances the cursor; USD null + reason when no series covers the denom.
const https = require('https'), zlib = require('zlib'), crypto = require('crypto');
const { classifyNftTx, buildIndex, recordKey } = require('./lib/classify.js');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/nft-collections';
const SLUG          = String(process.env.COLLECTION || '').trim();
const TLA_CORE_RAW  = process.env.TLA_CORE_RAW || 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const RPC_PRIMARY   = process.env.RPC_PRIMARY   || 'https://terra-rpc.publicnode.com';
const RPC_FALLBACK  = process.env.RPC_FALLBACK  || 'https://terra-rpc.polkachu.com';
const CONC          = Number(process.env.WALK_CONCURRENCY || 4);
const MAX_BLOCKS    = Number(process.env.MAX_BLOCKS_PER_RUN || 4000);
const LAG           = Number(process.env.HEAD_LAG || 10);
const PACE_MS       = Number(process.env.PACE_MS || 60);
const DRY           = /^1|true$/i.test(String(process.env.DRY_RUN || ''));
const CURSOR_PATH   = `${SLUG}/ledger/cursor.json`, HB_PATH = `${SLUG}/nft-flows/heartbeat.json`, LEDGER = `${SLUG}/ledger`, RAWF = `${SLUG}/raw/forward`;
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const errors = [];

// ---------------------------------------------------------------- http / rpc
function httpGet(url, t = 25000) {
  return new Promise((res, rej) => {
    const r = (url.startsWith('http:') ? require('http') : https).get(url, { agent: url.startsWith('http:') ? undefined : AGENT, headers: { Accept: 'application/json', 'User-Agent': 'org-nft-flows/1.0' } }, (x) => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => { if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } } else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 80)}`)); });
    });
    r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
  });
}
async function rpc(p, label) {
  let last;
  for (let a = 1; a <= 3; a++) {
    for (const base of [RPC_PRIMARY, RPC_FALLBACK]) { try { const r = await httpGet(base + p); await sleep(PACE_MS); return r; } catch (e) { last = e; } }
    await sleep(500 * a);
  }
  throw new Error(`${label}: ${last && last.message}`);
}
const txHashOf = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase();
async function getBlock(N) { const b = await rpc(`/block?height=${N}`, `block ${N}`); if (!b.result || !b.result.block) throw new Error(`PRUNED: height ${N} is below the node's retention floor — run nft-collections › nft-flows-walk on the archive node from the cursor to a retained height, derive, then this cron resumes from the new coverage edge`); return { time: b.result.block.header.time, txsB64: b.result.block.data.txs || [] }; }
async function getBlockResults(N) { const r = await rpc(`/block_results?height=${N}`, `results ${N}`); if (!r.result) throw new Error(`PRUNED: block_results ${N} unavailable`); return (r.result.txs_results || []).map(t => ({ code: t.code || 0, events: t.events || [] })); }
async function getHead() { const s = await rpc('/status', 'status'); return Number(s.result.sync_info.latest_block_height); }

// ---------------------------------------------------------------- github (Contents API; transient retry; 409 merge-retry by re-read)
function ghReqOnce(method, apiPath, body, accept) {
  return new Promise((resolve, reject) => {
    const GA = new URL(process.env.GITHUB_API || 'https://api.github.com');
    const opts = { hostname: GA.hostname, port: GA.port || undefined, path: apiPath, method, headers: { 'User-Agent': 'org-nft-flows', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = (GA.protocol === 'http:' ? require('http') : https).request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(accept ? d : JSON.parse(d || '{}')); } catch { resolve(d); } } else { const e = new Error(`GitHub ${res.statusCode} ${apiPath} ${d.slice(0, 120)}`); e.statusCode = res.statusCode; reject(e); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function ghReq(method, apiPath, body, accept) {
  let last;
  for (let a = 1; a <= 5; a++) { try { return await ghReqOnce(method, apiPath, body, accept); } catch (e) { last = e; const sc = e.statusCode; const transient = !sc || sc >= 500 || sc === 429 || (sc === 403 && /rate limit/i.test(e.message)); if (!transient) throw e; await sleep(Math.min(20000, 700 * Math.pow(2, a))); } }
  throw last;
}
async function readFile(p) {   // → { data (parsed, gz-aware), sha } | null
  try {
    const meta = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`);
    const raw = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw');   // raw media type: the JSON form blanks content >1MB
    const buf = Buffer.from(raw, 'binary');
    const data = p.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(buf)) : JSON.parse(raw);
    return { data, sha: meta.sha };
  } catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function writeFile(p, buf, msg, sha) {
  if (DRY) { console.log(`  [dry] would write ${p} (${buf.length} B)`); return; }
  for (let a = 1; a <= 4; a++) {
    try { await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/${p}`, Object.assign({ message: msg, content: Buffer.from(buf).toString('base64'), branch: GITHUB_BRANCH }, sha ? { sha } : {})); return; }
    catch (e) { if ((e.statusCode === 409 || e.statusCode === 422) && a < 4) { const cur = await readFile(p); sha = cur ? cur.sha : undefined; await sleep(400 * a); continue; } throw e; }
  }
}
const writeJson = (p, obj, msg, sha) => writeFile(p, JSON.stringify(obj, null, 1) + '\n', msg, sha);
const writeGz   = (p, obj, msg, sha) => writeFile(p, zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 }), msg, sha);

// ---------------------------------------------------------------- USD at the day (same rule as derive.js)
let LUNA = null;
const USDC_IBC = /^ibc\/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB$/;
function usdAt(price, ts) {
  if (!price || price.amount == null || !price.denom) return { usd: null, usd_reason: 'no_price' };
  const day = String(ts).slice(0, 10); const amt = Number(price.amount) / 1e6;
  if (price.denom === 'uluna') { const px = LUNA && LUNA[day]; return px != null ? { usd: amt * px, luna_usd: px } : { usd: null, usd_reason: 'luna_usd_daily_missing:' + day }; }
  if (USDC_IBC.test(price.denom)) return { usd: amt };
  return { usd: null, usd_reason: 'no_usd_series_for_denom:' + price.denom };
}

// ---------------------------------------------------------------- main
(async () => {
  if (!GITHUB_TOKEN && !DRY) throw new Error('GITHUB_TOKEN missing — refusing to run (no publish target).');
  if (!SLUG) throw new Error('COLLECTION missing — one service per collection (env COLLECTION=<slug>)');
  const cj = await readFile(`${SLUG}/collection.json`); if (!cj || !cj.data.capture) throw new Error(`${SLUG}/collection.json missing or has no capture block`);
  const vj = await readFile('venues.json'); if (!vj) throw new Error('venues.json missing');
  const R = { venues: vj.data.venues, collections: { [SLUG]: Object.assign({ label: cj.data.name, collection: cj.data.nft_contract, supply: cj.data.supply, kind: cj.data.kind }, cj.data.capture) } };
  const idx = buildIndex(R); const cols = [SLUG];
  // watch set = every collection contract + custodians + launchpads + distributors + every venue (offers/deposits are venue-only records)
  const watchOf = {}; const WATCH = new Set();
  for (const [k, c] of Object.entries(R.collections)) { const s = new Set([c.collection, ...Object.keys(c.custodians || {}), c.distributor, c.launchpad && c.launchpad.address, ...(c.distribution_wallets || [])].filter(Boolean)); watchOf[k] = s; s.forEach(a => WATCH.add(a)); }
  for (const vk of (R.collections[SLUG].venues || [])) { const v = R.venues[vk]; if (v && v.address) WATCH.add(v.address); }   // only the venues THIS collection lists on
  try { LUNA = (await httpGet(TLA_CORE_RAW + 'nfts/adao/snapshots/luna-usd-daily.json')).daily || null; } catch (e) { errors.push('luna-usd-daily: ' + e.message); }

  // cursor: stored, else derived from each ledger's full coverage (min across collections so none is skipped)
  let cur = await readFile(CURSOR_PATH); let cursor = cur && Number(cur.data.height);
  if (!cursor) {
    const ends = [];
    const ix = await readFile(`${LEDGER}/index.json`); const full = ix ? (ix.data.coverage || []).filter(c => !c.partial) : []; if (full.length) ends.push(Math.max(...full.map(c => c.to)));
    if (!ends.length) { const g = Number(R.collections[SLUG].genesis_height); if (g) ends.push(g - 1); }
    if (!ends.length) throw new Error(`no ledger coverage and no genesis_height for ${SLUG} — run the backfill (or set capture.genesis_height) first`);
    cursor = Math.min(...ends); console.log(`cursor bootstrapped from ${SLUG} ledger coverage: ${cursor}`);
  }
  const head = await getHead() - LAG; const from = cursor + 1; const to = Math.min(head, cursor + MAX_BLOCKS);
  console.log(`org-nft-flows-${SLUG} · cursor ${cursor} · head ${head} · walking ${from} → ${to} (${Math.max(0, to - from + 1)} blocks) · watch ${WATCH.size}`);
  if (to < from) { await heartbeat('ok', { cursor, head, walked: 0, matched: 0, note: 'nothing new' }); console.log('done: nothing new'); process.exit(0); }

  // ---- walk (tla-flows pattern: concurrency, any failed read stops the run BEFORE the cursor moves)
  const matched = []; let processedTo = cursor;
  const inFlight = new Map(); const launch = (h) => { if (h <= to && !inFlight.has(h)) inFlight.set(h, getBlock(h)); };
  for (let h = from; h < from + CONC && h <= to; h++) launch(h);
  try {
    for (let N = from; N <= to; N++) {
      const blk = await inFlight.get(N); inFlight.delete(N); launch(N + CONC);
      if (blk.txsB64.length) {
        const results = await getBlockResults(N);
        for (let i = 0; i < blk.txsB64.length; i++) {
          const res = results[i]; if (!res) continue;
          let hit = false; for (const e of res.events || []) { if (e.type !== 'wasm') continue; for (const a of e.attributes || []) if (a.key === '_contract_address' && WATCH.has(a.value)) { hit = true; break; } if (hit) break; }
          if (hit) matched.push({ h: N, x: txHashOf(blk.txsB64[i]), t: blk.time, c: res.code, e: res.events });
        }
      }
      processedTo = N;
    }
  } catch (e) { errors.push(`walk stopped at ${processedTo + 1}: ${e.message}`); console.warn('  ⚠ ' + errors[errors.length - 1]); if (/PRUNED/.test(e.message) && processedTo === cursor) { await heartbeat('failed', { cursor, head, walked: 0, matched: 0, pruned_at: processedTo + 1 }); console.error('FATAL ' + e.message); process.exit(1); } }
  console.log(`  walked to ${processedTo} · ${matched.length} matched`);

  // ---- raw before ledger: per collection, per day file
  const touchesCol = (tx, k) => (tx.e || []).some(e => e.type === 'wasm' && (e.attributes || []).some(a => a.key === '_contract_address' && watchOf[k].has(a.value)));
  const rawPer = {}; for (const tx of matched) for (const k of cols) if (touchesCol(tx, k)) (rawPer[k] ||= []).push(tx);
  // venue-only txs (deposit/withdraw/offer) touch no collection contract: archive them under every collection listing on that venue
  const venueAddr = new Set(Object.values(R.venues || {}).map(v => v.address)); const venueKeyOf = {}; for (const [vk, v] of Object.entries(R.venues || {})) venueKeyOf[v.address] = vk;
  for (const tx of matched) { if (cols.some(k => touchesCol(tx, k))) continue; const vks = new Set(); for (const e of tx.e || []) if (e.type === 'wasm') for (const a of e.attributes || []) if (a.key === '_contract_address' && venueAddr.has(a.value)) vks.add(venueKeyOf[a.value]); for (const k of cols) if ((R.collections[k].venues || []).some(v => vks.has(v))) (rawPer[k] ||= []).push(tx); }
  let rawFiles = 0;
  for (const [k, txs] of Object.entries(rawPer)) {
    const byDay = {}; txs.forEach(tx => (byDay[String(tx.t).slice(0, 10)] ||= []).push(tx));
    for (const [day, list] of Object.entries(byDay)) {
      const p = `${RAWF}/${day}.json.gz`; const ex = await readFile(p); const seen = new Set(((ex && ex.data) || []).map(t => t.x));
      const merged = [...((ex && ex.data) || []), ...list.filter(t => !seen.has(t.x))].sort((a, b) => a.h - b.h);
      if (merged.length === ((ex && ex.data) || []).length) continue;
      await writeGz(p, merged, `nft-flows forward raw ${k} ${day} (+${merged.length - ((ex && ex.data) || []).length})`, ex && ex.sha); rawFiles++;
    }
  }

  // ---- ledger: classify, USD, merge by key into month files, refresh index
  const recs = matched.flatMap(tx => classifyNftTx({ txhash: tx.x, height: tx.h, timestamp: tx.t, code: tx.c, events: tx.e }, R, idx));
  const perCol = {}; for (const r of recs) { if (r.collection) (perCol[r.collection] ||= []).push(r); else if (r.venue) for (const k of cols) if ((R.collections[k].venues || []).includes(r.venue)) (perCol[k] ||= []).push(Object.assign({}, r, { collection: k })); }
  let added = 0; const perColAdded = {};
  for (const [k, list] of Object.entries(perCol)) {
    const byMonth = {}; list.forEach(r => { r.source = 'forward:org-nft-flows'; if (r.price) Object.assign(r, usdAt(r.price, r.ts)); (byMonth[String(r.ts).slice(0, 7).replace('-', '/')] ||= []).push(r); });
    const monthsTouched = {};
    for (const [mk, rs] of Object.entries(byMonth)) {
      const p = `${LEDGER}/${mk}.json`; const ex = await readFile(p); const existing = (ex && Array.isArray(ex.data)) ? ex.data : []; const seen = new Set(existing.map(recordKey));
      const fresh = rs.filter(r => !seen.has(recordKey(r))); if (!fresh.length) continue;
      const merged = [...existing, ...fresh].sort((a, b) => a.height - b.height || a.msg_index - b.msg_index);
      await writeJson(p, merged, `nft-flows forward ${k} ${mk} (+${fresh.length})`, ex && ex.sha); added += fresh.length; perColAdded[k] = (perColAdded[k] || 0) + fresh.length; monthsTouched[mk] = merged;
    }
    if (Object.keys(monthsTouched).length) {
      const ixf = await readFile(`${LEDGER}/index.json`); const ix = (ixf && ixf.data) || { product: `${k}/ledger`, schema: 'nft-flows-1.0', collection: k, total: 0, by_kind: {}, months: [], coverage: [], known_gaps: [] };
      for (const [mk, merged] of Object.entries(monthsTouched)) { if (!ix.months.includes(mk)) ix.months.push(mk); ix.months.sort(); }
      const bk = {}; let total = 0; for (const mk of ix.months) { const m = monthsTouched[mk] || ((await readFile(`${LEDGER}/${mk}.json`)) || { data: [] }).data; total += m.length; m.forEach(r => { bk[r.kind] = (bk[r.kind] || 0) + 1; }); }
      ix.total = total; ix.by_kind = bk;
      const fw = ix.coverage.find(c => c.source === 'forward:org-nft-flows'); if (fw) fw.to = Math.max(fw.to, processedTo); else ix.coverage.push({ source: 'forward:org-nft-flows', from: from, to: processedTo, parts: 0 });
      ix.forward_stream = `org-nft-flows-${k} (Render, hourly) → ${k}/raw/forward + this ledger`; ix.updatedAt = new Date().toISOString();
      await writeJson(`${LEDGER}/index.json`, ix, `nft-flows forward ${k} index`, ixf && ixf.sha);
    }
  }
  // collections with nothing new still get their coverage edge moved (the walk covered them)
  for (const k of cols) { if (perColAdded[k]) continue; const ixf = await readFile(`${LEDGER}/index.json`); if (!ixf) continue; const ix = ixf.data; const fw = ix.coverage.find(c => c.source === 'forward:org-nft-flows'); if (fw) { if (processedTo > fw.to) { fw.to = processedTo; ix.updatedAt = new Date().toISOString(); await writeJson(`${LEDGER}/index.json`, ix, `nft-flows forward ${k} coverage → ${processedTo}`, ixf.sha); } } else { ix.coverage.push({ source: 'forward:org-nft-flows', from, to: processedTo, parts: 0 }); ix.updatedAt = new Date().toISOString(); await writeJson(`${LEDGER}/index.json`, ix, `nft-flows forward ${k} coverage start`, ixf.sha); } }

  // ---- cursor LAST (raw + ledger are on main before we say so), then heartbeat
  if (processedTo > cursor) await writeJson(CURSOR_PATH, { height: processedTo, updatedAt: new Date().toISOString(), note: `block cursor for org-nft-flows-${SLUG}; this service walks only this collection` }, `nft-flows cursor → ${processedTo}`, cur && cur.sha);
  await heartbeat(errors.length ? 'degraded' : 'ok', { cursor: processedTo, head, walked: processedTo - cursor, matched: matched.length, raw_files: rawFiles, records_added: added, per_collection: perColAdded });
  console.log(`done: +${added} ledger records, ${rawFiles} raw files, cursor ${processedTo}, ${Date.now() - t0} ms`);
  process.exit(0);   // keep-alive sockets would otherwise hold the process open on Render
})().catch(async (e) => { console.error('FATAL', e); errors.push(e.message); try { await heartbeat('failed', {}); } catch { } process.exit(1); });

async function heartbeat(status, extra) {
  const hb = Object.assign({ module: 'nft-collections', product: `${SLUG}/nft-flows`, cron: `org-nft-flows-${SLUG}`, version: '1.1.1', status, ran_at: new Date().toISOString(), duration_ms: Date.now() - t0, errors }, extra);
  const ex = await readFile(HB_PATH).catch(() => null);
  await writeJson(HB_PATH, hb, `nft-flows heartbeat ${status}`, ex && ex.sha);
}
