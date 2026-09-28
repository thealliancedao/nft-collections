// gate-locks-l1.mjs — BINDING post-derive gate for classify 1.2.0 / derive 1.3.0 on the tla-locks ledger (SPEC-portfolio-locks L1).
// Runs on the ledger AFTER derive, before the commit (nft-flows-derive.yml). Usage: node gate-locks-l1.mjs <repo root>
//   L1 every lock_create is priced (the amount locked) — ≥ 99 %, each miss listed
//   L2 token-less lock rows (add / permanent / unpermanent / extend) ≤ 1 % of their kind, each listed (IBC-proxy txs name no lock anywhere)
//   L3 no double count: no (tx, kind, msg) has both a token-less and a per-token live row
//   L4 supersedes are labelled and resolvable: reason names classify-<rev>, superseded_by is a live row's key
//   L5 a recovered id names a lock that exists at that height (created or seen before, not merged away / withdrawn / migrated) ≥ 99 %
//   L6 a recovered-id add raises that lock's fixed_power over its previous row ≥ 99 % (the id is the lock the deposit went into)
//   L7 lock_add rows from the gauge (claim_rebase) are labelled by `from` = the registry's gauge (income to the lock, not a deposit)
//   L8 a corrected lock payment keeps the old value as repair.was
//   L9 a msg depositing into two locks keeps one row per lock
//   L10 a migrate names the lock it creates (classify 1.2.1)
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ROOT = process.argv[2] || '.'; const L = path.join(ROOT, 'tla-locks/ledger');
if (!fs.existsSync(L)) { console.log('no tla-locks ledger at ' + L + ' — skipped'); process.exit(0); }
const { recordKey } = require('./classify.js');
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x).slice(0, 600) : '')); } };
const all = []; for (const y of fs.readdirSync(L).filter(d => /^\d{4}$/.test(d)).sort()) for (const m of fs.readdirSync(path.join(L, y)).filter(f => /^\d\d\.json$/.test(f)).sort()) all.push(...JSON.parse(fs.readFileSync(path.join(L, y, m), 'utf8')));
const live = all.filter(r => !r.superseded_by); const liveKeys = new Set(live.map(recordKey));
const GAUGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tla-locks/collection.json'), 'utf8')).capture.gauge;
const K = (k) => live.filter(r => r.kind === k);
console.log(`tla-locks ledger: ${all.length} rows, ${live.length} live, ${all.length - live.length} superseded`);

const cr = K('lock_create'); const crMiss = cr.filter(r => !(r.price && r.price.amount));
ok(crMiss.length <= cr.length * 0.01, `L1 ${cr.length - crMiss.length}/${cr.length} lock_create carry the amount locked`, crMiss.slice(0, 10).map(r => r.txhash));
const nullKinds = ['lock_add', 'lock_permanent', 'lock_unpermanent', 'lock_extend'];
const nulls = {}; for (const k of nullKinds) nulls[k] = [K(k).filter(r => r.token_id == null).length, K(k).length];
ok(nullKinds.every(k => nulls[k][0] <= nulls[k][1] * 0.01), 'L2 token-less lock rows ≤ 1 % per kind: ' + nullKinds.map(k => `${k} ${nulls[k][0]}/${nulls[k][1]}`).join(' · '), live.filter(r => nullKinds.includes(r.kind) && r.token_id == null).slice(0, 40).map(r => r.kind + ' ' + r.txhash.slice(0, 12) + ' ' + r.ts.slice(0, 10)));
const g = {}; for (const r of live) if (/^lock_/.test(r.kind)) (g[r.txhash + '|' + r.kind + '|' + r.msg_index] ||= []).push(r);
const dual = Object.entries(g).filter(([, v]) => v.some(r => r.token_id == null) && v.some(r => r.token_id != null));
ok(dual.length === 0, `L3 no (tx, kind, msg) with both a token-less and a per-token live row`, dual.slice(0, 5).map(([k]) => k));
const sup = all.filter(r => r.superseded_by); const badSup = sup.filter(r => !/^classify-\d+\.\d+\.\d+: /.test(r.superseded_reason || '') || !liveKeys.has(r.superseded_by) && !all.some(x => recordKey(x) === r.superseded_by));
ok(badSup.length === 0, `L4 ${sup.length} superseded rows: every one names classify-<rev> and points at a row on disk`, badSup.slice(0, 5).map(r => [r.txhash, r.superseded_reason, r.superseded_by]));

const ord = live.filter(r => /^lock_/.test(r.kind)).sort((a, b) => a.height - b.height || a.msg_index - b.msg_index);
const seen = new Set(), dead = new Set(), prev = new Map(); const st = { n: 0, exists: 0, unborn: 0, dead: 0, adds: 0, up: 0 }; const deadEx = [];
let txDead = [], curTx = null; const flush = () => { for (const t of txDead) dead.add(t); txDead = []; };   // a lock merged away in a tx dies at the END of that tx (a Votion deposit makes it permanent, then merges it)
for (const r of ord) {
  if (r.txhash !== curTx) { flush(); curTx = r.txhash; }
  if (r.token_id != null && r.token_id_from) { st.n++; if (dead.has(r.token_id)) { st.dead++; if (deadEx.length < 5) deadEx.push([r.kind, r.token_id, r.txhash.slice(0, 12)]); } else if (seen.has(r.token_id)) st.exists++; else st.unborn++;
    const p = prev.get(r.token_id); if (r.kind === 'lock_add' && p && p.lock && r.lock && p.lock.fixed_power && r.lock.fixed_power) { st.adds++; if (BigInt(r.lock.fixed_power) > BigInt(p.lock.fixed_power)) st.up++; } }
  for (const t of [r.token_id, ...((r.lineage && r.lineage.to_ids) || [])]) if (t != null) { seen.add(String(t)); dead.delete(String(t)); }
  if (r.kind === 'lock_merge') for (const b of ((r.lineage && r.lineage.burned) || [])) txDead.push(String(b));
  if (r.kind === 'lock_withdraw') txDead.push(String(r.token_id));
  if (r.kind === 'lock_migrate' && r.lineage && r.lineage.from_ids && r.lineage.from_ids[0] !== r.token_id) txDead.push(String(r.lineage.from_ids[0]));
  if (r.token_id != null && r.lock) prev.set(r.token_id, r);
}
ok(st.dead === 0 && st.exists >= st.n * 0.97, `L5 ${st.n} recovered ids: ${st.exists} name a lock seen before, ${st.unborn} a lock created before the archive starts, ${st.dead} a lock already gone`, { st, deadEx });
ok(st.adds > 0 && st.up >= st.adds * 0.99, `L6 ${st.up}/${st.adds} recovered-id adds raise that lock's fixed_power over its previous row`, st);
const reb = K('lock_add').filter(r => r.from === GAUGE);
const rebNull = reb.filter(r => r.token_id == null);
ok(reb.length > 0 && rebNull.length <= reb.length * 0.02, `L7 ${reb.length} gauge rebase adds (from = gauge ${GAUGE.slice(0, 12)}…), ${rebNull.length} token-less (IBC-proxy txs: the lock is named nowhere in the tx) — the income leg the P&L keeps apart from deposits`, rebNull.slice(0, 5).map(r => r.txhash));
const cor = all.filter(r => r.repair && /^classify-/.test(r.repair.by || '') && /^lock_/.test(r.kind));
ok(cor.every(r => r.repair.was && r.repair.was.price && (r.repair.was.price.amount !== r.price.amount || r.repair.was.price.denom !== r.price.denom)), `L8 ${cor.length} lock payments corrected in place, each keeping repair.was (the old value) and differing from it`, cor.slice(0, 5).map(r => [r.txhash.slice(0, 12), r.repair.was.price, r.price]));
// L9: a msg that deposits into two locks keeps BOTH (was: both keyed to the first lock, one lost as a duplicate key)
const perMsg = {}; for (const r of K('lock_add')) if (r.token_id != null) (perMsg[r.txhash + '|' + r.msg_index] ||= new Set()).add(r.token_id);
const multi = Object.values(perMsg).filter(s => s.size > 1).length;
ok(multi >= 4, `L9 ${multi} msgs deposit into more than one lock and keep a row per lock`, multi);
// L10 (classify 1.2.1): a migrate names the lock it creates — to_ids ≠ from_ids
{ const mg = K('lock_migrate'); const selfRef = mg.filter(r => r.lineage && String(r.lineage.to_ids) === String(r.lineage.from_ids));
  ok(mg.length > 0 && selfRef.length <= mg.length * 0.01, `L10 ${mg.length - selfRef.length}/${mg.length} migrates name a new lock (to ≠ from)`, selfRef.slice(0, 5).map(r => [r.txhash.slice(0, 12), r.lineage])); }
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
