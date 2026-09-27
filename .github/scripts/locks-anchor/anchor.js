'use strict';
// locks-anchor 1.0.0 (2026-09-27) — SPEC-portfolio-locks L2: the escrow's OWN answer for a lock at the heights where an owner's
// basis starts or ends. The venue's contract is the source: `lock_info{token_id}` at height H returns the lock's asset + amount,
// underlying_amount (the escrow's LUNA value at lock/restamp), fixed_amount, voting_power, coefficient, start/end — the numbers
// the ledger rows can only approximate (fixed_power drifts with the escrow's own LST rate; rebases compound in).
//
// WHERE IT READS (planned from the tla-locks ledger, live rows only):
//   create           (h, after)                      — what the creator put in, by the escrow's count
//   lock_transfer    (h, after)                      — the lock a new owner receives (basis "received" = value at receipt)
//   split            parent (h-1, before) + (h, after) · child (h, after)
//   migrate          old id (h-1, before) · new id (h, after)
//   now              every lock alive at the run's head (one height for all: the anchor the P&L ends on)
//   A lock that dies inside its own block (created and merged into a Votion vault's lock in one tx) cannot be read after that
//   block: planned, then SKIPPED with the reason — never guessed.
//
// HOW IT READS: the archive RPC (secret ARCHIVE_RPC, the same node nft-flows-walk uses) — `abci_query` on
//   /cosmwasm.wasm.v1.Query/SmartContractState with `height`; the request is the two-field protobuf, the answer's field 1 is the
//   contract's JSON. Nothing else is needed (no LCD secret).
//
// THE ARCHIVE IS A COURTESY (the ally-positions backfill rules, verbatim in spirit): one request in flight, RPS default 2 (ceiling
//   4); 429/5xx/timeout → back off 5 s / 20 s / 60 s, at most 3 retries; 5 consecutive failures → the run STOPS and writes what it
//   has; MAX_REQUESTS (default 6,000, ceiling 20,000) and MAX_MINUTES (default 100, ceiling 300) end the run cleanly; the script
//   refuses to start unless RUN_MODE=manual (the Action sets it); the User-Agent names the site.
//   A contract ERROR at a height (code ≠ 0: "not found", pruned) is an ANSWER — stored with its log, never counted against the
//   node, not re-asked unless RETRY_ANSWERS=1. A transport failure is not stored: the next run asks again.
//
// WRITES (never-shrink, write-once per (token, height, side)):
//   tla-locks/ledger/anchors/<shard>.json   { tokens: { <id>: [ { height, side, why[], lock | error, read_at } ] } }  shard = floor(id/100)
//   tla-locks/ledger/anchors/index.json     plan counts, read / answered-error / skipped / pending, head, stopped, by why
//   Flushed every FLUSH_EVERY reads (default 200), so a cancelled run keeps what it read.
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');
const VERSION = 'locks-anchor-1.0.0';

// ---------------------------------------------------------------- pure: plan + protobuf (exported for the gate)
const byOrder = (a, b) => a.height - b.height || a.msg_index - b.msg_index;
function plan(rows, head) {
  const live = rows.filter(r => !r.superseded_by && /^lock_/.test(r.kind)).sort(byOrder);
  const pts = new Map();   // key token|height|side → point
  const add = (tok, height, side, why) => { if (tok == null || !(height > 0)) return; const k = `${tok}|${height}|${side}`; const p = pts.get(k); if (p) { if (!p.why.includes(why)) p.why.push(why); } else pts.set(k, { token_id: String(tok), height, side, why: [why] }); };
  const diesAt = new Map();   // token → height its lock is merged away / withdrawn / migrated out
  const alive = new Set();
  let curTx = null, txDead = [];
  const flush = (h) => { for (const t of txDead) { alive.delete(t); diesAt.set(t, h); } txDead = []; };
  let lastH = 0;
  for (const r of live) {
    if (r.txhash !== curTx) { flush(lastH); curTx = r.txhash; }
    lastH = r.height;
    const tok = r.token_id != null ? String(r.token_id) : null;
    if (r.kind === 'lock_create' && tok) { add(tok, r.height, 'after', 'create'); alive.add(tok); }
    else if (r.kind === 'lock_transfer' && tok) add(tok, r.height, 'after', 'transfer');
    else if (r.kind === 'lock_split') { const par = r.lineage && r.lineage.from_ids && r.lineage.from_ids[0]; if (par) { add(par, r.height - 1, 'before', 'split_parent'); add(par, r.height, 'after', 'split_parent'); } if (tok) { add(tok, r.height, 'after', 'split_child'); alive.add(tok); } }
    else if (r.kind === 'lock_migrate') { const old = r.lineage && r.lineage.from_ids && r.lineage.from_ids[0]; const nw = (r.lineage && r.lineage.to_ids && r.lineage.to_ids[0]) || tok; if (old) add(old, r.height - 1, 'before', 'migrate_from'); if (nw) { add(nw, r.height, 'after', 'migrate_to'); alive.add(String(nw)); } if (old && nw && String(old) !== String(nw)) txDead.push(String(old)); }
    else if (r.kind === 'lock_merge') { for (const b of ((r.lineage && r.lineage.burned) || [])) txDead.push(String(b)); if (tok) alive.add(tok); }
    else if (r.kind === 'lock_withdraw' && tok) txDead.push(tok);
    else if (tok && r.kind !== 'lock_withdraw') alive.add(tok);   // a lock first seen by an add/permanent (created before the archive starts)
  }
  flush(lastH);
  if (head) for (const t of alive) add(t, head, 'now', 'now');
  const out = [];
  for (const p of pts.values()) { const d = diesAt.get(p.token_id); if (p.side !== 'before' && d != null && p.height >= d) p.skip = `the lock is gone at h${d} (merged / withdrawn / migrated in that block) — no state after it to read`; out.push(p); }
  return out.sort((a, b) => a.height - b.height || (a.token_id < b.token_id ? -1 : 1));
}
const varint = (n) => { const b = []; while (n > 127) { b.push((n & 127) | 128); n = Math.floor(n / 128); } b.push(n); return Buffer.from(b); };
function smartReq(addr, query) { const a = Buffer.from(addr), d = Buffer.from(JSON.stringify(query)); return Buffer.concat([Buffer.from([0x0a]), varint(a.length), a, Buffer.from([0x12]), varint(d.length), d]); }
function readVarint(buf, i) { let n = 0, m = 1, b; do { b = buf[i++]; n += (b & 127) * m; m *= 128; } while (b & 128); return [n, i]; }
function smartResp(b64) { const buf = Buffer.from(b64 || '', 'base64'); if (!buf.length) return null; if (buf[0] !== 0x0a) throw new Error('unexpected protobuf tag ' + buf[0]); const [len, i] = readVarint(buf, 1); return JSON.parse(buf.slice(i, i + len).toString('utf8')); }
const shardOf = (id) => /^\d+$/.test(String(id)) ? String(Math.floor(Number(id) / 100)).padStart(3, '0') : 'x';
const keyOf = (p) => `${p.token_id}|${p.height}|${p.side}`;

// ---------------------------------------------------------------- run
async function main(env) {
  env = env || process.env;
  const ROOT = env.ROOT || process.cwd(); const SLUG = env.COLLECTION || 'tla-locks';
  const clampNum = (v, dflt, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const RPS = clampNum(env.RPS, 2, 0.2, 4), MAX_REQUESTS = clampNum(env.MAX_REQUESTS, 6000, 20, 20000), MAX_MINUTES = clampNum(env.MAX_MINUTES, 100, 1, 300);
  const MAX_FAIL = clampNum(env.MAX_CONSECUTIVE_FAILURES, 5, 1, 10), FLUSH_EVERY = clampNum(env.FLUSH_EVERY, 200, 1, 5000);
  const BACKOFF = (env.BACKOFF_MS || '5000,20000,60000').split(',').map(Number);
  const RPC = String(env.ARCHIVE_RPC || '').trim().replace(/^['"]+|['"]+$/g, '').replace(/\/+$/, '');
  const DRY = /^(1|true)$/i.test(String(env.DRY || '')); const RETRY_ANSWERS = /^(1|true)$/i.test(String(env.RETRY_ANSWERS || ''));
  if (env.RUN_MODE !== 'manual') throw new Error('RUN_MODE=manual required (the Action sets it) — this job reads a courtesy archive node and never runs on a schedule');
  if (!RPC && !DRY) throw new Error('ARCHIVE_RPC is required (the archive RPC secret)');
  const UA = `thealliancedao.com locks-anchor/1.0 (one-off, throttled ${RPS} rps; contact via the site)`;
  const col = JSON.parse(fs.readFileSync(path.join(ROOT, SLUG, 'collection.json'), 'utf8')); const ESC = col.nft_contract;
  const L = path.join(ROOT, SLUG, 'ledger'), A = path.join(L, 'anchors');
  const rows = []; for (const y of fs.readdirSync(L).filter(d => /^\d{4}$/.test(d)).sort()) for (const m of fs.readdirSync(path.join(L, y)).filter(f => /^\d\d\.json$/.test(f)).sort()) rows.push(...JSON.parse(fs.readFileSync(path.join(L, y, m), 'utf8')));
  const budget = { started: Date.now(), requests: 0, retries: 0, fails: 0, stopped: null, lastAt: 0 };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const left = () => { if (budget.stopped) return false; if (budget.requests >= MAX_REQUESTS) budget.stopped = `MAX_REQUESTS ${MAX_REQUESTS} reached`; else if (Date.now() - budget.started > MAX_MINUTES * 60000) budget.stopped = `MAX_MINUTES ${MAX_MINUTES} reached`; else if (budget.fails >= MAX_FAIL) budget.stopped = `${MAX_FAIL} consecutive failures — the node is refusing or down; not pushing further`; return !budget.stopped; };
  const get = (url) => new Promise((res, rej) => { const r = (url.startsWith('http:') ? http : https).get(url, { headers: { Accept: 'application/json', 'User-Agent': UA } }, (x) => { let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode, body: b, retryAfter: Number(x.headers['retry-after']) || 0 })); }); r.on('error', rej); r.setTimeout(30000, () => r.destroy(new Error('timeout'))); });
  async function rpc(p) {
    for (let attempt = 0; ; attempt++) {
      if (!left()) return { stopped: true };
      const gap = 1000 / RPS, wait = budget.lastAt + gap - Date.now(); if (wait > 0) await sleep(wait); budget.lastAt = Date.now(); budget.requests++;
      let r; try { r = await get(RPC + p); } catch (e) { r = { status: 0, body: e.message }; }
      if (r.status === 200) { try { const j = JSON.parse(r.body); budget.fails = 0; return { json: j }; } catch { r.status = 0; r.body = 'bad JSON'; } }
      const transient = r.status === 0 || [429, 502, 503, 504].includes(r.status);
      if (!transient) { budget.fails = 0; return { http: `HTTP ${r.status} ${String(r.body).slice(0, 160)}` }; }   // a 4xx is an answer about the request
      budget.fails++;
      if (attempt < BACKOFF.length && left()) { budget.retries++; await sleep(r.retryAfter ? Math.min(r.retryAfter * 1000, 120000) : BACKOFF[attempt]); continue; }
      return { failed: `transport: ${r.status || ''} ${String(r.body).slice(0, 120)}` };
    }
  }
  async function lockInfoAt(tok, height) {
    const data = '0x' + smartReq(ESC, { lock_info: { token_id: String(tok) } }).toString('hex');
    const r = await rpc(`/abci_query?path=%22/cosmwasm.wasm.v1.Query/SmartContractState%22&data=${data}&height=${height}`);
    if (r.stopped) return { stopped: true }; if (r.failed) return { failed: r.failed }; if (r.http) return { answer_error: r.http };
    const resp = r.json && r.json.result && r.json.result.response; if (!resp) return { failed: 'no result.response' };
    if (resp.code) return { answer_error: `code ${resp.code}: ${String(resp.log || '').slice(0, 200)}` };
    try { const lock = smartResp(resp.value); return lock ? { lock } : { answer_error: 'empty answer (code 0, no value)' }; } catch (e) { return { answer_error: 'undecodable answer: ' + e.message }; }
  }
  // head: one height for every "now" point
  let head = Number(env.HEAD_HEIGHT || 0);
  if (!head && !DRY) { const s = await rpc('/status'); head = Number(s.json && s.json.result && s.json.result.sync_info && s.json.result.sync_info.latest_block_height) || 0; if (!head) throw new Error('could not read the archive head: ' + JSON.stringify(s).slice(0, 200)); head -= 20; }   // 20 blocks back: settled
  const points = plan(rows, head || null);
  // what is on disk
  fs.mkdirSync(A, { recursive: true });
  const shards = new Map(); const loadShard = (sh) => { if (!shards.has(sh)) { const p = path.join(A, sh + '.json'); shards.set(sh, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { product: `${SLUG}/ledger/anchors`, collection: SLUG, shard: sh, tokens: {} }); } return shards.get(sh); };
  const have = (p) => { const s = loadShard(shardOf(p.token_id)); const list = s.tokens[p.token_id] || []; return list.find(x => x.height === p.height && x.side === p.side); };
  const dirty = new Set();
  const put = (p, rec) => { const sh = shardOf(p.token_id); const s = loadShard(sh); const list = (s.tokens[p.token_id] ||= []); const i = list.findIndex(x => x.height === p.height && x.side === p.side); const row = Object.assign({ height: p.height, side: p.side, why: p.why }, rec, { read_at: new Date().toISOString() }); if (i >= 0) list[i] = row; else list.push(row); list.sort((a, b) => a.height - b.height || (a.side === 'before' ? -1 : 1)); dirty.add(sh); };
  const stats = { planned: points.length, already: 0, read: 0, answered_error: 0, skipped: 0, pending: 0, by_why: {} };
  const flush = () => { if (DRY) return; for (const sh of dirty) { const s = shards.get(sh); s.updatedAt = new Date().toISOString(); s.tokens_with_anchors = Object.keys(s.tokens).length; fs.writeFileSync(path.join(A, sh + '.json'), JSON.stringify(s, null, 1) + '\n'); } dirty.clear(); };
  let sinceFlush = 0;
  for (const p of points) {
    for (const w of p.why) stats.by_why[w] = (stats.by_why[w] || 0) + 1;
    const h = have(p);
    if (h && (h.lock || h.skipped || (h.error && !RETRY_ANSWERS))) { stats.already++; continue; }
    if (p.skip) { put(p, { skipped: p.skip }); stats.skipped++; continue; }
    if (DRY || budget.stopped) { stats.pending++; continue; }
    const r = await lockInfoAt(p.token_id, p.height);
    if (r.stopped || r.failed) { stats.pending++; if (r.failed) console.warn(`  ⚠ ${p.token_id} h${p.height}: ${r.failed}`); continue; }   // not stored: the next run asks again
    if (r.lock) { put(p, { lock: r.lock }); stats.read++; } else { put(p, { error: r.answer_error }); stats.answered_error++; }
    if (++sinceFlush >= FLUSH_EVERY) { flush(); sinceFlush = 0; console.log(`  … ${stats.read} read, ${stats.answered_error} answered with an error, ${budget.requests} requests, ${Math.round((Date.now() - budget.started) / 1000)} s`); }
  }
  flush();
  const index = { product: `${SLUG}/ledger/anchors`, version: VERSION, method: 'lock_info{token_id} at height via archive RPC abci_query (SmartContractState)', contract: ESC, head_height: head || null,
    plan: { points: stats.planned, by_why: stats.by_why }, this_run: { read: stats.read, answered_error: stats.answered_error, skipped: stats.skipped, already_on_disk: stats.already, pending: stats.pending, requests: budget.requests, retries: budget.retries, stopped: budget.stopped, seconds: Math.round((Date.now() - budget.started) / 1000), rps: RPS },
    note: 'side: before = state at h-1, after = state at h (after the event), now = state at head_height. error = the contract answered with an error at that height (kept, not re-asked). skipped = the lock is gone in that block. pending = not read yet (budget / node) — the next run continues.', updatedAt: new Date().toISOString() };
  if (!DRY) fs.writeFileSync(path.join(A, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  console.log(`${VERSION}: ${stats.planned} points planned (${JSON.stringify(stats.by_why)}) · ${stats.already} already on disk · ${stats.read} read · ${stats.answered_error} answered with an error · ${stats.skipped} skipped · ${stats.pending} pending · ${budget.requests} requests${budget.stopped ? ' · STOPPED: ' + budget.stopped : ''}${DRY ? ' (DRY — nothing read or written)' : ''}`);
  return { index, stats };
}
module.exports = { VERSION, plan, smartReq, smartResp, shardOf, keyOf, main };
if (require.main === module) main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
