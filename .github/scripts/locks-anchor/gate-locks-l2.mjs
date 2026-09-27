// gate-locks-l2.mjs — BINDING post-run gate for locks-anchor 1.0.0 (SPEC-portfolio-locks L2). Runs on the anchors AFTER a run,
// before the commit. Relations, not literals — each check ties the escrow's answer back to a ledger row it must agree with:
//   A1 structure: every anchor row is (height, side ∈ before/after/now, why[]) with exactly one of lock / error / skipped; no
//      (token, height, side) twice; a lock answer carries asset.amount
//   A2 creates: the lock's asset at the create block = the payment the ledger recorded for that create (amount AND denom)
//      — ≥ 99 % of the creates read (an add in the same block is the known exception, listed)
//   A3 splits: parent before = parent after + child after, in asset amount — ≥ 99 % of complete triples (the escrow conserves)
//   A4 migrates: the old lock's asset before the block = the amount the ledger's migrate row says left it — ≥ 99 %
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
// A3 splits
{ let n = 0, eq = 0; const miss = []; const grp = new Map();   // a parent split several times in one block: before = after + Σ children
  for (const r of live.filter(x => x.kind === 'lock_split' && x.lineage && x.lineage.from_ids && x.lineage.from_ids[0] && x.token_id)) { const k = String(r.lineage.from_ids[0]) + '|' + r.height; (grp.get(k) || grp.set(k, []).get(k)).push(String(r.token_id)); }
  for (const [k, kids] of grp) { const [par, hs] = k.split('|'); const h = Number(hs); const b = at(par, h - 1, 'before'), a = at(par, h, 'after'), cs = kids.map(c => at(c, h, 'after')); if (!(b && b.lock && a && a.lock && cs.every(c => c && c.lock))) continue; n++; const sum = cs.reduce((s, c) => s + amt(c), 0n); if (amt(b) === amt(a) + sum) eq++; else miss.push([par, kids, h, String(amt(b)), String(amt(a)), String(sum)]); }
  ok(n === 0 ? true : eq >= n * 0.99, `A3 ${eq}/${n} splits conserve the asset: parent before = parent after + Σ children (per parent per block)`, miss.slice(0, 5)); }
// A4 migrates
{ let n = 0, eq = 0; const miss = [];
  for (const r of live.filter(x => x.kind === 'lock_migrate' && x.migrate && x.migrate.amount_before && x.lineage)) { const old = String(r.lineage.from_ids[0]); const b = at(old, r.height - 1, 'before'); if (!b || !b.lock) continue; n++; const m = String(r.migrate.amount_before).match(/:(\d+)$/); if (m && String(amt(b)) === m[1]) eq++; else miss.push([old, r.height, r.migrate.amount_before, b.lock.asset]); }
  ok(n === 0 ? true : eq >= n * 0.99, `A4 ${eq}/${n} migrates: the old lock's asset before the block = the ledger's migrate amount`, miss.slice(0, 5)); }
// A5 coverage
{ const planned = idx.plan && idx.plan.points; const run = idx.this_run || {}; const onDisk = n;
  ok(planned != null && onDisk + (run.pending || 0) >= planned && (run.stopped || run.pending === 0), `A5 ${onDisk} on disk + ${run.pending || 0} pending ≥ ${planned} planned${run.stopped ? ' (run stopped: ' + run.stopped + ' — the next run continues)' : ''}`, { planned, onDisk, run }); }
// A6 honesty
{ const errs = [...anchors.values()].filter(r => r.error); const emptyErr = errs.filter(r => !String(r.error).trim()); const skippedWithLock = [...anchors.values()].filter(r => r.skipped && r.lock);
  ok(emptyErr.length === 0 && skippedWithLock.length === 0, `A6 ${errs.length} error rows each carry the node's answer; no skipped row carries a lock`, { emptyErr: emptyErr.length, skippedWithLock: skippedWithLock.length }); }
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
