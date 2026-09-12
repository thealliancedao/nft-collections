// gate-import-adao.mjs — runs import-from-tla-core.js (WHAT=adao) in SRC_DIR mode against a local tla-core checkout
// inside a scratch copy of this repo, then asserts: every aDAO product + the two FCD archives copied byte-for-byte,
// adao/ledger untouched, collection.json rewritten as specified, second run is a no-op, a drifted file is overwritten
// and reported. Usage: node gate-import-adao.mjs <tla-core-dir> <nft-collections-dir>
import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto';
const [SRC, NC] = process.argv.slice(2); let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')); for (const d of ['.github', 'adao']) fs.cpSync(path.join(NC, d), path.join(tmp, d), { recursive: true });
fs.mkdirSync(path.join(tmp, 'adao/ledger'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'adao/ledger/index.json'), '{"live":"ledger — must not be touched"}\n');
const run = (env = {}) => spawnSync('node', ['.github/scripts/nft-flows/import-from-tla-core.js'], { cwd: tmp, env: { PATH: process.env.PATH, SRC_DIR: SRC, WHAT: 'adao', ...env }, encoding: 'utf8' });
const walk = (d) => { const o = []; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); e.isDirectory() ? w(p) : o.push(p); } })(d); return o.sort(); };
const sha = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
console.log('— R1 first run —'); let r = run(); ck('exit 0', r.status === 0, r.stderr.slice(-300)); console.log(r.stdout.trim().split('\n').map(l => '    ' + l).join('\n'));
const PAIRS = [['nfts/adao/snapshots', 'adao/snapshots'], ['nfts/adao/flows', 'adao/flows'], ['nfts/adao/transfers', 'adao/transfers'], ['nfts/adao/provenance', 'adao/provenance'], ['nfts/adao/claims', 'adao/claims'], ['archive/fcd/adao-collection', 'adao/archive/fcd/collection'], ['archive/fcd/adao-minter', 'adao/archive/fcd/minter']];
let total = 0;
for (const [a, b] of PAIRS) { const A = walk(path.join(SRC, a)), B = fs.existsSync(path.join(tmp, b)) ? walk(path.join(tmp, b)) : []; const relA = A.map(p => path.relative(path.join(SRC, a), p)), relB = B.map(p => path.relative(path.join(tmp, b), p)); total += A.length;
  ck(`${b}: ${A.length} files, same set`, JSON.stringify(relA) === JSON.stringify(relB), { missing: relA.filter(x => !relB.includes(x)).slice(0, 5), extra: relB.filter(x => !relA.includes(x)).slice(0, 5) });
  ck(`${b}: byte-identical`, relA.every(x => fs.existsSync(path.join(tmp, b, x)) && sha(path.join(SRC, a, x)) === sha(path.join(tmp, b, x)))); }
ck(`imported ${total} files reported`, new RegExp(`imported ${total} files`).test(r.stdout), r.stdout.match(/imported \d+ files/));
ck('adao/ledger untouched', fs.readFileSync(path.join(tmp, 'adao/ledger/index.json'), 'utf8').includes('must not be touched'));
const c = JSON.parse(fs.readFileSync(path.join(tmp, 'adao/collection.json'), 'utf8')).capture.archives;
ck('collection.json: FCD archives declared local (collection, minter)', JSON.stringify(c.fcd) === '["collection","minter"]', c.fcd);
ck('collection.json: tla-core:archive/fcd entries removed, tla-flows/raw kept', c.external_coverage.length === 1 && c.external_coverage[0].source === 'tla-core:tla-flows/raw', c.external_coverage);
ck('collection.json: notes rewritten', /live here under adao\//.test(c.note) && /stays in tla-core/.test(c.external_note));
ck('collection.json: everything outside capture.archives unchanged', (() => { const a = JSON.parse(fs.readFileSync(path.join(NC, 'adao/collection.json'), 'utf8')), b = JSON.parse(fs.readFileSync(path.join(tmp, 'adao/collection.json'), 'utf8')); delete a.capture.archives; delete b.capture.archives; return JSON.stringify(a) === JSON.stringify(b); })());
console.log('— R2 second run is a no-op —'); r = run(); ck('exit 0', r.status === 0); ck('imported 0 files', /imported 0 files/.test(r.stdout), r.stdout.trim().split('\n').pop()); ck('collection.json not rewritten again', !/rewritten/.test(r.stdout));
console.log('— R3 drift: a same-size but changed summary.json is overwritten and reported —');
{ const p = path.join(tmp, 'adao/snapshots/summary.json'); const buf = fs.readFileSync(p); const mut = Buffer.from(buf); mut[mut.length - 3] = mut[mut.length - 3] === 0x20 ? 0x21 : 0x20; fs.writeFileSync(p, mut);
  r = run(); ck('exit 0', r.status === 0); ck('exactly 1 file re-imported', /imported 1 files/.test(r.stdout), r.stdout.trim().split('\n').pop()); ck('overwrite reported by path', /OVERWROTE 1 existing file/.test(r.stdout) && r.stdout.includes('adao/snapshots/summary.json')); ck('content restored byte-identical', sha(p) === sha(path.join(SRC, 'nfts/adao/snapshots/summary.json'))); }
console.log('— R4 WHAT=ledgers touches nothing under adao/ now that the tla-core sources are gone —');
{ const before = walk(path.join(tmp, 'adao')).map(p => p + ':' + sha(p)).join('|'); r = run({ WHAT: 'ledgers' }); ck('exit 0', r.status === 0); ck('adao/ unchanged (incl. the live ledger)', before === walk(path.join(tmp, 'adao')).map(p => p + ':' + sha(p)).join('|')); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== IMPORT-ADAO GATE: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
