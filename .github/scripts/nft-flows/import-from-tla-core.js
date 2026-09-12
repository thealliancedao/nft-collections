'use strict';
// import-from-tla-core.js — ONE-TIME copies from tla-core into each collection's folder here. Never touches tla-core.
//
// v1 (2026-09-12): the nft-flows outputs — pixel-lions / tla-locks ledgers, raw parts, FCD archives, the aDAO ledger.
//   (Those tla-core sources were PURGED the same day; the mappings stay for the record and now resolve to 0 files.)
// v2 (2026-09-12 late, aDAO migration): kind `adao` — the five aDAO products (snapshots, flows, transfers, provenance,
//   claims) and the two aDAO FCD archives move to adao/. After the copy, adao/collection.json capture.archives is
//   rewritten so the two FCD archives are declared LOCAL (adao/archive/fcd/{collection,minter}); tla-flows/raw stays
//   external (it is TLA data).
//
// Copy rule: a file is written only when its git blob SHA differs from what is already here (content, never size —
// heartbeat/summary files change with identical byte counts). Overwrites are listed so drift is visible.
// Idempotent: a second run with nothing changed imports 0 files and rewrites nothing.
//
// RUN ORDER for the aDAO flip (owner, Render): suspend org-nft-inventory · org-nft-adao-daily · org-tla-flows →
//   run this (WHAT=adao) → set the env on those three services → resume. That way nothing is written to the
//   old location after the copy, and nothing here is overwritten by an older copy.
//
// Env: GITHUB_TOKEN (trees API), WHAT = all | ledgers | raw | fcd | adao (default adao), SRC_DIR = local tla-core
// checkout instead of the API (gate use only).
const https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const TOKEN = process.env.GITHUB_TOKEN, SRC = 'thealliancedao/tla-core', WHAT = process.env.WHAT || 'adao', SRC_DIR = process.env.SRC_DIR || '';
const MAP = [
  { from: 'nfts/pixel/ledger/', to: 'pixel-lions/ledger/', kind: 'ledgers' }, { from: 'nfts/raw/pixel/', to: 'pixel-lions/raw/', kind: 'raw' },
  { from: 'archive/fcd/pixel-collection/', to: 'pixel-lions/archive/fcd/collection/', kind: 'fcd' }, { from: 'archive/fcd/pixel-voting/', to: 'pixel-lions/archive/fcd/voting/', kind: 'fcd' }, { from: 'archive/fcd/pixel-enterprise/', to: 'pixel-lions/archive/fcd/enterprise/', kind: 'fcd' },
  { from: 'nfts/tla-locks/ledger/', to: 'tla-locks/ledger/', kind: 'ledgers' }, { from: 'archive/fcd/tla-escrow/', to: 'tla-locks/archive/fcd/escrow/', kind: 'fcd' },
  { from: 'nfts/adao/ledger/', to: 'adao/ledger/', kind: 'ledgers' },
  // v2 — the aDAO migration
  { from: 'nfts/adao/snapshots/',  to: 'adao/snapshots/',  kind: 'adao' },
  { from: 'nfts/adao/flows/',      to: 'adao/flows/',      kind: 'adao' },
  { from: 'nfts/adao/transfers/',  to: 'adao/transfers/',  kind: 'adao' },
  { from: 'nfts/adao/provenance/', to: 'adao/provenance/', kind: 'adao' },
  { from: 'nfts/adao/claims/',     to: 'adao/claims/',     kind: 'adao' },
  { from: 'archive/fcd/adao-collection/', to: 'adao/archive/fcd/collection/', kind: 'adao' },
  { from: 'archive/fcd/adao-minter/',     to: 'adao/archive/fcd/minter/',     kind: 'adao' },
];
const get = (url, headers = {}) => new Promise((res, rej) => https.get(url, { headers: Object.assign({ 'User-Agent': 'nft-collections-import' }, headers) }, r => { const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => r.statusCode < 300 ? res(Buffer.concat(ch)) : rej(new Error(`HTTP ${r.statusCode} ${url}`))); }).on('error', rej));
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
function localTree(root) {   // SRC_DIR mode: same shape as the trees API (path, size, sha), blobs only
  const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const b = fs.readFileSync(p); out.push({ type: 'blob', path: path.relative(root, p).split(path.sep).join('/'), size: b.length, sha: blobSha(b) }); } } })(root); return out;
}
const fetchSrc = async (p) => SRC_DIR ? fs.readFileSync(path.join(SRC_DIR, p)) : get(`https://raw.githubusercontent.com/${SRC}/main/${p}`);
(async () => {
  const tree = SRC_DIR ? localTree(SRC_DIR) : JSON.parse(await get(`https://api.github.com/repos/${SRC}/git/trees/main?recursive=1`, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' })).tree;
  let n = 0, bytes = 0; const overwrote = [], touched = new Set();
  for (const m of MAP) {
    if (WHAT !== 'all' && m.kind !== WHAT) continue;
    const files = tree.filter(t => t.type === 'blob' && t.path.startsWith(m.from));
    console.log(`${m.from} → ${m.to}: ${files.length} files`);
    for (const f of files) {
      const dest = path.join(m.to, f.path.slice(m.from.length)); fs.mkdirSync(path.dirname(dest), { recursive: true });
      const exists = fs.existsSync(dest);
      if (exists && blobSha(fs.readFileSync(dest)) === f.sha) continue;             // identical content — no-op
      const buf = await fetchSrc(f.path);
      if (blobSha(buf) !== f.sha) throw new Error(`fetched content for ${f.path} does not match the tree sha — refusing to write a torn copy`);
      fs.writeFileSync(dest, buf); n++; bytes += buf.length; touched.add(m.to); if (exists) overwrote.push(dest);
      if (!SRC_DIR) await new Promise(r => setTimeout(r, 40));
    }
  }
  // v1 ledger re-keys — ONLY for a ledger folder this run actually wrote to (the adao ledger is live under Render now;
  // never rewrite it on a run that did not import into it)
  for (const [slug, oldKey] of [['pixel-lions', 'pixel'], ['tla-locks', 'tla-locks'], ['adao', 'adao']]) {
    const lr = path.join(slug, 'ledger'); if (!touched.has(lr + '/') || !fs.existsSync(lr)) continue;
    for (const y of fs.readdirSync(lr).filter(d => /^\d{4}$/.test(d))) for (const mo of fs.readdirSync(path.join(lr, y))) { const fp = path.join(lr, y, mo); const arr = JSON.parse(fs.readFileSync(fp, 'utf8')); if (!Array.isArray(arr)) continue; let ch = 0; arr.forEach(r => { if (r.collection !== slug) { r.collection = slug; ch++; } }); if (ch) fs.writeFileSync(fp, JSON.stringify(arr, null, 1) + '\n'); }
    const p = path.join(lr, 'index.json'); if (!fs.existsSync(p)) continue; const ix = JSON.parse(fs.readFileSync(p, 'utf8')); ix.product = `${slug}/ledger`; ix.collection = slug; ix.imported_from = 'thealliancedao/tla-core (2026-09-12 backfill); coverage sources keep their original tla-core names'; ix.forward_stream = `org-nft-flows-${slug} (Render) → ${slug}/raw/forward + this ledger`; fs.writeFileSync(p, JSON.stringify(ix, null, 1) + '\n');
  }
  // v2 — declare the two aDAO FCD archives local once they are here; tla-flows/raw stays external (TLA data)
  if ((WHAT === 'all' || WHAT === 'adao') && fs.existsSync('adao/archive/fcd/collection') && fs.existsSync('adao/archive/fcd/minter')) {
    const cp = 'adao/collection.json'; const c = JSON.parse(fs.readFileSync(cp, 'utf8')); const a = (c.capture = c.capture || {}).archives || (c.capture.archives = {});
    const before = JSON.stringify(a);
    a.fcd = ['collection', 'minter'];
    a.external_coverage = (a.external_coverage || []).filter(e => !/^tla-core:archive\/fcd\/adao-/.test(e.source));
    a.note = 'FCD archives (collection, minter) live here under adao/archive/fcd/; the aDAO products (snapshots, flows, transfers, provenance, claims) live here under adao/ since the 2026-09-12 migration; forward capture writes here';
    a.external_note = 'tla-flows/raw stays in tla-core (TLA data, registry superset); its aDAO ledger records were imported — that range is counted as covered';
    if (JSON.stringify(a) !== before) { fs.writeFileSync(cp, JSON.stringify(c, null, 1) + '\n'); console.log('adao/collection.json capture.archives rewritten (FCD archives now local)'); }
  }
  console.log(`imported ${n} files, ${(bytes / 1048576).toFixed(1)} MB${overwrote.length ? ` — OVERWROTE ${overwrote.length} existing file(s):\n  ` + overwrote.join('\n  ') : ''}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
