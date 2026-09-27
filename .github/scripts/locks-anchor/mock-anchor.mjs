// mock-anchor.mjs — BINDING gate for locks-anchor 1.0.0 against a mock archive RPC (the sandbox cannot reach the node).
// A real ledger month (tla-locks 2025-08: creates, transfers, splits, migrates, Votion same-block merges) → a temp repo; the mock answers
// abci_query SmartContractState at height from a replay of those same rows (create = payment, add +=, split child = ⅓ of
// the parent, merge folds, migrate = the new asset, withdrawn/merged away = code 5 "not found"), in the escrow's protobuf.
//   M1 protobuf: request bytes decode to (escrow, {lock_info:{token_id}}); an answer round-trips
//   M2 RUN_MODE guard: refuses without RUN_MODE=manual
//   M3 courtesy: one request in flight, gaps ≥ 1/RPS, the User-Agent names the site; three 503s back off and are retried
//   M4 budget: MAX_REQUESTS stops the run cleanly, what it read is on disk, the rest is `pending`
//   M5 resume: the next run reads only what is missing; a third run makes 0 smart queries
//   M6 answers: a code-5 answer is stored as `error` (not a transport failure) and not re-asked; skipped points are never queried
//   M7 a dead node: every call 503 → the run STOPS after 5 consecutive failures, writes nothing wrong, reports pending
//   M8 the post-run gate (gate-locks-l2.mjs) runs on the mock's anchors: structure, creates, coverage, honesty pass; the split and
//      migrate reconciles run on real triples (their verdict is the real run's)
// Usage: node mock-anchor.mjs <nft-collections root>
import fs from 'fs'; import path from 'path'; import http from 'http'; import os from 'os'; import { execFileSync } from 'child_process'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SRC = path.resolve(process.argv[2] || '.'); const HERE = path.dirname(new URL(import.meta.url).pathname);
const AN = require('./anchor.js');
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x).slice(0, 500) : '')); } };
const ESC = JSON.parse(fs.readFileSync(path.join(SRC, 'tla-locks/collection.json'), 'utf8')).nft_contract;
// temp repo: collection.json + two real ledger months
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-')); fs.mkdirSync(path.join(T, 'tla-locks/ledger/2025'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'tla-locks/collection.json'), path.join(T, 'tla-locks/collection.json'));
for (const m of ['2025/08.json']) fs.copyFileSync(path.join(SRC, 'tla-locks/ledger', m), path.join(T, 'tla-locks/ledger', m));
const rows = [...JSON.parse(fs.readFileSync(path.join(T, 'tla-locks/ledger/2025/08.json')))].filter(r => !r.superseded_by).sort((a, b) => a.height - b.height || a.msg_index - b.msg_index);
// the mock chain: state after every row, by height
const hist = new Map();   // token → [{h, amount, denom} | {h, dead:true}]
const cur = new Map(); const push = (t, h) => { const s = cur.get(t); (hist.get(t) || hist.set(t, []).get(t)).push(s ? { h, ...s } : { h, dead: true }); };
const info = (d) => d && d.startsWith('cw20:') ? { cw20: d.slice(5) } : { native: d || 'uluna' };
for (const r of rows) { const t = r.token_id != null ? String(r.token_id) : null;
  if (r.kind === 'lock_create' && t) { cur.set(t, { amount: BigInt(r.price.amount), denom: r.price.denom }); push(t, r.height); }
  else if (r.kind === 'lock_add' && t) { const s = cur.get(t) || { amount: 0n, denom: r.price.denom }; s.amount += BigInt(r.price.amount); cur.set(t, s); push(t, r.height); }
  else if (r.kind === 'lock_split' && t && r.lineage.from_ids[0]) { const p = String(r.lineage.from_ids[0]); const s = cur.get(p) || { amount: 300n, denom: 'uluna' }; const c = s.amount / 3n; cur.set(p, { amount: s.amount - c, denom: s.denom }); cur.set(t, { amount: c, denom: s.denom }); push(p, r.height); push(t, r.height); }
  else if (r.kind === 'lock_merge' && t) { const s = cur.get(t) || { amount: 0n, denom: 'uluna' }; for (const b of r.lineage.burned || []) { const x = cur.get(String(b)); if (x) s.amount += x.amount; cur.delete(String(b)); push(String(b), r.height); } cur.set(t, s); push(t, r.height); }
  else if (r.kind === 'lock_migrate') { const o = String(r.lineage.from_ids[0]); const nw = String(r.lineage.to_ids[0] || t); const mb = String(r.migrate.amount_before || '').match(/^(?:native|cw20):([^:]+):(\d+)$/); if (!cur.has(o) && mb) { cur.set(o, { amount: BigInt(mb[2]), denom: mb[1].startsWith('terra1') ? 'cw20:' + mb[1] : mb[1] }); (hist.get(o) || hist.set(o, []).get(o)).push({ h: r.height - 1, ...cur.get(o) }); } const into = String(r.migrate.into || '').match(/^(?:native|cw20):([^:]+):(\d+)$/); cur.delete(o); push(o, r.height); if (into) { cur.set(nw, { amount: BigInt(into[2]), denom: into[1].startsWith('terra1') ? 'cw20:' + into[1] : into[1] }); push(nw, r.height); } }
  else if (r.kind === 'lock_withdraw' && t) { cur.delete(t); push(t, r.height); }
  else if (t && !cur.has(t) && r.kind !== 'lock_transfer') { cur.set(t, { amount: 1000n, denom: 'uluna' }); push(t, r.height - 1); } }
const stateAt = (t, h) => { const l = hist.get(t) || []; let s = null; for (const x of l) if (x.h <= h) s = x; return s; };
// server
const HEAD = 17500000; let mode = 'ok', fiveOhThrees = 0; const calls = []; const smartQs = [];
const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); calls.push({ t: Date.now(), ua: req.headers['user-agent'], path: u.pathname });
  if (mode === 'dead' || (mode === 'ok' && fiveOhThrees > 0 && u.pathname === '/abci_query' && fiveOhThrees--)) { res.writeHead(503); return res.end('busy'); }
  if (u.pathname === '/status') { res.writeHead(200); return res.end(JSON.stringify({ result: { sync_info: { latest_block_height: String(HEAD + 20) } } })); }
  if (u.pathname !== '/abci_query') { res.writeHead(404); return res.end('no'); }
  const h = Number(u.searchParams.get('height')); const data = Buffer.from(u.searchParams.get('data').slice(2), 'hex');
  // decode request: field1 address, field2 query
  let i = 1; let len = data[i++]; if (len & 128) { len = (len & 127) + data[i++] * 128; } const addr = data.slice(i, i + len).toString(); i += len; i++; let l2 = 0, m = 1, b; do { b = data[i++]; l2 += (b & 127) * m; m *= 128; } while (b & 128); const q = JSON.parse(data.slice(i, i + l2).toString());
  smartQs.push({ addr, q, h }); const t = q.lock_info && q.lock_info.token_id; const s = stateAt(String(t), h);
  if (addr !== ESC || !s || s.dead) { res.writeHead(200); return res.end(JSON.stringify({ result: { response: { code: 5, log: `failed to execute message; message index: 0: Lock ${t} not found: query wasm contract failed`, value: null, height: String(h) } } })); }
  const j = Buffer.from(JSON.stringify({ asset: { info: info(s.denom), amount: String(s.amount) }, underlying_amount: String(s.amount), fixed_amount: String(s.amount), voting_power: '0', coefficient: '8', start: 1, end: 'permanent', slope: '0' }));
  const v = Buffer.concat([Buffer.from([0x0a]), (() => { const o = []; let n = j.length; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); })(), j]);
  res.writeHead(200); res.end(JSON.stringify({ result: { response: { code: 0, value: v.toString('base64'), height: String(h) } } })); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const RPC = `http://127.0.0.1:${srv.address().port}`;
const env = (o) => Object.assign({ ROOT: T, COLLECTION: 'tla-locks', ARCHIVE_RPC: RPC, RUN_MODE: 'manual', RPS: '4', BACKOFF_MS: '50,100,150', FLUSH_EVERY: '25' }, o);
const silent = async (fn) => { const l = console.log, w = console.warn; const out = []; console.log = (...a) => out.push(a.join(' ')); console.warn = (...a) => out.push(a.join(' ')); try { return [await fn(), out]; } finally { console.log = l; console.warn = w; } };

// M1
{ const b = AN.smartReq(ESC, { lock_info: { token_id: '7' } }); const back = Buffer.from(JSON.stringify({ a: 1 })); const v = Buffer.concat([Buffer.from([0x0a, back.length]), back]).toString('base64');
  ok(b[0] === 0x0a && b.slice(2, 2 + b[1]).toString() === ESC && JSON.parse(b.slice(2 + b[1] + 2).toString()).lock_info.token_id === '7' && AN.smartResp(v).a === 1, 'M1 protobuf request = (escrow, {lock_info:{token_id}}); an answer decodes'); }
// M2
{ let threw = null; try { await AN.main(env({ RUN_MODE: '' })); } catch (e) { threw = e.message; } ok(/RUN_MODE=manual/.test(threw || ''), 'M2 refuses to start without RUN_MODE=manual', threw); }
// M3 + M4: three 503s, then a budget stop
fiveOhThrees = 3; calls.length = 0;
const [r1] = await silent(() => AN.main(env({ MAX_REQUESTS: '60' })));
const gaps = calls.slice(1).map((c, i) => c.t - calls[i].t); const minGap = Math.min(...gaps);
const planned = r1.index.plan.points, skips = r1.stats.skipped;
ok(minGap >= 240 && calls.every(c => /thealliancedao\.com locks-anchor/.test(c.ua)) && r1.index.this_run.retries >= 3, `M3 sequential at ≤ 4 rps (min gap ${minGap} ms), UA names the site, ${r1.index.this_run.retries} backoff retries after 503s`, { minGap, retries: r1.index.this_run.retries });
ok(/MAX_REQUESTS 60/.test(r1.index.this_run.stopped || '') && r1.stats.read + r1.stats.answered_error > 40 && r1.stats.pending > 0 && fs.existsSync(path.join(T, 'tla-locks/ledger/anchors/index.json')), `M4 budget stop: ${r1.stats.read} read + ${r1.stats.answered_error} answered on disk, ${r1.stats.pending} pending, stopped "${r1.index.this_run.stopped}"`, r1.index.this_run);
// M5 resume
smartQs.length = 0; const [r2] = await silent(() => AN.main(env({})));
const q2 = smartQs.length; smartQs.length = 0; const [r3] = await silent(() => AN.main(env({})));
ok(r2.stats.pending === 0 && q2 === planned - skips - (r1.stats.read + r1.stats.answered_error) && smartQs.length === 0 && r3.stats.already === planned, `M5 resume: run 2 asked only the ${q2} missing points, run 3 asked none (${r3.stats.already}/${planned} on disk)`, { q2, planned, skips, r2: r2.stats, r3: r3.stats });
// M6 answers vs skips
{ const all = []; for (const f of fs.readdirSync(path.join(T, 'tla-locks/ledger/anchors')).filter(x => /^\d{3}\.json$/.test(x))) for (const [tok, l] of Object.entries(JSON.parse(fs.readFileSync(path.join(T, 'tla-locks/ledger/anchors', f))).tokens)) for (const x of l) all.push({ tok, ...x });
  const errs = all.filter(x => x.error), sk = all.filter(x => x.skipped); const skQueried = sk.filter(x => smartQs.some(q => q.q.lock_info.token_id === x.tok && q.h === x.height));
  ok(all.filter(x => x.lock).length > 0 && sk.length > 0 && errs.every(x => /not found/.test(x.error)) && skQueried.length === 0, `M6 ${errs.length} code-5 answers kept as error (not re-asked in run 3), ${sk.length} skipped points never queried`, { errs: errs.slice(0, 2), skQueried: skQueried.length }); }
// M7 dead node
{ const T2 = T + '-dead'; fs.cpSync(T, T2, { recursive: true }); fs.rmSync(path.join(T2, 'tla-locks/ledger/anchors'), { recursive: true }); mode = 'dead'; calls.length = 0;
  let res = null, err = null; try { [res] = await silent(() => AN.main(env({ ROOT: T2, HEAD_HEIGHT: String(HEAD) }))); } catch (e) { err = e.message; }
  ok(res && /5 consecutive failures/.test(res.index.this_run.stopped || '') && res.stats.read === 0 && res.stats.pending > 0 && calls.length <= 5 + 1, `M7 dead node: stopped after ${calls.length} calls ("${res && res.index.this_run.stopped}"), ${res && res.stats.pending} pending, nothing invented`, { err, calls: calls.length, stats: res && res.stats }); mode = 'ok'; }
// M8 the post-run gate on the mock's anchors
{ let out = '', code = 0; try { out = execFileSync('node', [path.join(HERE, 'gate-locks-l2.mjs'), T], { encoding: 'utf8' }); } catch (e) { out = e.stdout; code = e.status; }
  // the mock chain is a model (⅓ splits, invented amounts for locks older than the month): A1 A2 A5 A6 must PASS on it; A3/A4 must
  // RUN on real triples (n > 0) — whether the escrow conserves is the real run's question, not the mock's
  const lines = out.split('\n').filter(l => /^\s+[✓✗]/.test(l)); const passed = (a) => lines.some(l => l.includes('✓ ' + a + ' '));
  const nOf = (a) => { const m = out.match(new RegExp(a + ' \\d+\\/(\\d+)')); return m ? Number(m[1]) : 0; };
  ok(lines.length === 6 && ['A1', 'A2', 'A5', 'A6'].every(passed) && nOf('A3') > 0 && nOf('A4') > 0, 'M8 gate-locks-l2 on the mock anchors: ' + lines.map(l => l.trim().slice(0, 70)).join(' | '), out.slice(-600)); }
srv.close(); fs.rmSync(T, { recursive: true, force: true }); fs.rmSync(T + '-dead', { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
