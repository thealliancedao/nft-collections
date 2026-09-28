// gate-locks-l2.mjs — BINDING post-run gate for locks-anchor 1.0.0 (SPEC-portfolio-locks L2). Runs on the anchors AFTER a run,
// before the commit. Relations, not literals — each check ties the escrow's answer back to a ledger row it must agree with:
//   A1 structure: every anchor row is (height, side ∈ before/after/now, why[]) with exactly one of lock / error / skipped; no
//      (token, height, side) twice; a lock answer carries asset.amount
//   A2 creates: the lock's asset at the create block = the payment the ledger recorded for that create (amount AND denom)
//      — ≥ 99 % of the creates read (an add in the same block is the known exception, listed)
//   A3 conservation per lock per block: before = after + Σ split children + migrated out — ≥ 99 % (split + migrate in one block together)
//   A4 migrates: the new lock's asset right after = the ledger's migrate `into` — ≥ 99 % of those read
//   A5 coverage: planned points on disk + pending = planned (index.json), and a run that was not stopped leaves 0 pending
//   A6 answers are honest: an `error` row names the node's answer; no lock answer where the plan said skip
// Usage: node gate-locks-l2.mjs <repo root> [slug]
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ROOT = process.argv[2] || '.'; const SLUG = process.argv[3] || 'tla-locks';
const A = path.join(ROOT, SLUG, 'ledger', 'anchors'), L = path.join(ROOT, SLUG, 'ledger');
if (!fs.existsSync(path.join(A, 'index.json'))) { console.log('no anchors/index.json — nothing to gate'); process.exit(0); }
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x).slice(0, 700) : '')); } };
const idx = JSON.parse(fs.readFileSync(path.join(A, 'index.json'), 'utf8'));
const anchors = new Map(); let n = 0; const bad = []; const dupes = [];
for (const f of fs.readdirSync(A).filter(x => /^(\d{3}|x)\.json$/.test(x))) { const s = JSON.parse(fs.readFileSync(path.join(A, f), 'utf8')); for (const [tok, list] of Object.entries(s.tokens)) { const seen = new Set(); for (const r of list) { n++; const k = r.height + '|' + r.side; if (seen.has(k)) dupes.push(tok + '|' + k); seen.add(k); const kinds = ['lock', 'error', 'skipped'].filter(x => r[x] != null); if (!(r.height > 0) || !['before', 'after', 'now'].includes(r.side) || !Array.isArray(r.why) || kinds.length !== 1 || (r.lock && !(r.lock.asset && r.lock.asset.amount != null))) bad.push([tok, r]); anchors.set(tok + '|' + k, r); } } }
console.log(`${SLUG} anchors: ${n} rows (${[...anchors.values()].filter(r => r.lock).length} read, ${[...anchors.values()].filter(r => r.error).length} answered with an error, ${[...anchors.values()].filter(r => r.skipped).length} skipped) · head h${idx.head_height}`);
ok(bad.length === 0 && dupes.length === 0, `A1 ${n} anchor rows well-formed, no (token, height, side) twice`, { bad: bad.slice(0, 3), dupes: dupes.slice(0, 5) });
const rows = []; for (const y of fs.readdirSync(L).filter(d => /^\d{4}$/.test(d)).sort()) for (const m of fs.readdirSync(path.join(L, y)).filter(f => /^\d\d\.json$/.test(f)).sort()) rows.push(...JSON.parse(fs.readFileSync(path.join(L, y, m), 'utf8')));
const live = rows.filter(r => !r.superseded_by);
const at = (tok, h, side) => anchors.get(`${tok}|${h}|${side}`);
const denomOf = (info) => { if (!info) return null; if (info.cw20) return 'cw20:' + (typeof info.cw20 === 'string' ? info.cw20 : info.cw20.contract_addr); if (info.native) return typeof info.native === 'string' ? info.native : info.native.denom; if (info.token) return 'cw20:' + info.token.contract_addr; if (info.native_token) return info.native_token.denom; return null; };
const amt = (a) => a && a.lock && a.lock.asset ? BigInt(a.lock.asset.amount) : null;
const sameBlockAdds = new Set(live.filter(r => r.kind === 'lock_add' && r.token_id != null).map(r => r.token_id + '|' + r.height));
// A2 creates
{ let n = 0, eq = 0; const miss = [];
  for (const r of live.filter(x => x.kind === 'lock_create' && x.price && x.price.amount)) { const a = at(String(r.token_id), r.height, 'after'); if (!a || !a.lock) continue; n++; const same = String(amt(a)) === String(r.price.amount) && denomOf(a.lock.asset.info) === r.price.denom; if (same) eq++; else if (!sameBlockAdds.has(r.token_id + '|' + r.height)) miss.push([r.token_id, r.height, r.price, a.lock.asset]); }
  ok(n === 0 ? true : (eq + (n - eq - miss.length)) >= n * 0.99, `A2 ${eq}/${n} creates: the escrow's asset at the create block = the recorded payment (${n - eq - miss.length} with an add in the same block)`, miss.slice(0, 5)); }
// A3 + A4 — conservation PER LOCK PER BLOCK (the migration tool splits a lock and migrates the rest in ONE block, so a split and a
// migrate of the same lock are checked together): before(h-1) = after(h) + Σ split children after(h) + Σ migrated out (the ledger's
// amount_before; a migrated lock is burned, after = 0). Blocks where the lock also merges / receives an add / is withdrawn are left
// to L3 (counted as not checked).
const grp = new Map(); const addG = (t, h, e) => { const k = t + '|' + h; (grp.get(k) || grp.set(k, []).get(k)).push(e); };
for (const r of live) { if (r.kind === 'lock_split' && r.lineage && r.lineage.from_ids && r.lineage.from_ids[0] && r.token_id) addG(String(r.lineage.from_ids[0]), r.height, { k: 'split', child: String(r.token_id) });
  if (r.kind === 'lock_migrate' && r.lineage && r.lineage.from_ids) { const m = String((r.migrate && r.migrate.amount_before) || '').match(/:(\d+)$/); const mi = String((r.migrate && r.migrate.into) || '').match(/:(\d+)$/); addG(String(r.lineage.from_ids[0]), r.height, { k: 'migrate', out: m ? BigInt(m[1]) : null, into: mi ? BigInt(mi[1]) : null, to: String((r.lineage.to_ids && r.lineage.to_ids[0]) || '') }); }
  if (r.kind === 'lock_merge' && r.lineage) { for (const b of r.lineage.burned || []) addG(String(b), r.height, { k: 'other' }); addG(String(r.token_id), r.height, { k: 'other' }); }
  if ((r.kind === 'lock_add' || r.kind === 'lock_withdraw') && r.token_id) addG(String(r.token_id), r.height, { k: 'other' }); }
{ let n = 0, eq = 0, notChecked = 0; const miss = []; let mn = 0, meq = 0; const mmiss = [];
  for (const [k, es] of grp) { if (!es.some(e => e.k === 'split' || e.k === 'migrate')) continue; if (es.some(e => e.k === 'other')) { notChecked++; continue; }
    const [t, hs] = k.split('|'); const h = Number(hs); const b = at(t, h - 1, 'before'); const mig = es.filter(e => e.k === 'migrate');
    const kids = es.filter(e => e.k === 'split').map(e => at(e.child, h, 'after')); const a = mig.length ? null : at(t, h, 'after');
    if (!(b && b.lock) || kids.some(c => !(c && c.lock)) || (!mig.length && !(a && a.lock)) || mig.some(e => e.out == null)) { notChecked++; continue; }
    n++; const total = (mig.length ? 0n : amt(a)) + kids.reduce((s, c) => s + amt(c), 0n) + mig.reduce((s, e) => s + e.out, 0n);
    if (amt(b) === total) eq++; else miss.push([t, h, es.map(e => e.k).join('+'), String(amt(b)), String(total)]);
    for (const e of mig) { const nl = at(e.to, h, 'after'); if (!nl || !nl.lock || e.into == null) continue; mn++; if (amt(nl) === e.into) meq++; else mmiss.push([t, e.to, h, String(e.into), String(amt(nl))]); } }
  ok(n > 0 ? eq >= n * 0.99 : true, `A3 ${eq}/${n} lock-blocks conserve the asset: before = after + Σ split children + migrated out (${notChecked} blocks with a merge / add / withdraw left to L3)`, miss.slice(0, 5));
  ok(mn === 0 ? true : meq >= mn * 0.99, `A4 ${meq}/${mn} migrates: the NEW lock holds exactly what the ledger says the migration put in (${mn === 0 ? 'no new-lock reads yet — the next locks-anchor run reads them' : 'the escrow agrees'})`, mmiss.slice(0, 5)); }
// A5 coverage
{ const planned = idx.plan && idx.plan.points; const run = idx.this_run || {}; const onDisk = n;
  ok(planned != null && onDisk + (run.pending || 0) >= planned && (run.stopped || run.pending === 0), `A5 ${onDisk} on disk + ${run.pending || 0} pending ≥ ${planned} planned${run.stopped ? ' (run stopped: ' + run.stopped + ' — the next run continues)' : ''}`, { planned, onDisk, run }); }
// A6 honesty
{ const errs = [...anchors.values()].filter(r => r.error); const emptyErr = errs.filter(r => !String(r.error).trim()); const skippedWithLock = [...anchors.values()].filter(r => r.skipped && r.lock);
  ok(emptyErr.length === 0 && skippedWithLock.length === 0, `A6 ${errs.length} error rows each carry the node's answer; no skipped row carries a lock`, { emptyErr: emptyErr.length, skippedWithLock: skippedWithLock.length }); }
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
