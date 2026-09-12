'use strict';
// import-from-tla-core.js — one-time: copy the nft-flows outputs built inside tla-core into each collection's folder here.
// Mapping (tla-core → nft-collections):  nfts/pixel/ledger → pixel-lions/ledger · nfts/raw/pixel → pixel-lions/raw
//   archive/fcd/pixel-{collection,voting,enterprise} → pixel-lions/archive/fcd/{collection,voting,enterprise}
//   nfts/tla-locks/ledger → tla-locks/ledger · archive/fcd/tla-escrow → tla-locks/archive/fcd/escrow
//   nfts/adao/ledger → adao/ledger (aDAO's raw/FCD archives STAY in tla-core — the ledger is imported, forward capture continues here)
// Uses the git trees API (authenticated) to list, raw.githubusercontent to fetch. Never touches tla-core.
const https = require('https'), fs = require('fs'), path = require('path');
const TOKEN = process.env.GITHUB_TOKEN, SRC = 'thealliancedao/tla-core', WHAT = process.env.WHAT || 'all';
const MAP = [
  { from: 'nfts/pixel/ledger/', to: 'pixel-lions/ledger/', kind: 'ledgers' }, { from: 'nfts/raw/pixel/', to: 'pixel-lions/raw/', kind: 'raw' },
  { from: 'archive/fcd/pixel-collection/', to: 'pixel-lions/archive/fcd/collection/', kind: 'fcd' }, { from: 'archive/fcd/pixel-voting/', to: 'pixel-lions/archive/fcd/voting/', kind: 'fcd' }, { from: 'archive/fcd/pixel-enterprise/', to: 'pixel-lions/archive/fcd/enterprise/', kind: 'fcd' },
  { from: 'nfts/tla-locks/ledger/', to: 'tla-locks/ledger/', kind: 'ledgers' }, { from: 'archive/fcd/tla-escrow/', to: 'tla-locks/archive/fcd/escrow/', kind: 'fcd' },
  { from: 'nfts/adao/ledger/', to: 'adao/ledger/', kind: 'ledgers' },
];
const get = (url, headers = {}) => new Promise((res, rej) => https.get(url, { headers: Object.assign({ 'User-Agent': 'nft-collections-import' }, headers) }, r => { const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => r.statusCode < 300 ? res(Buffer.concat(ch)) : rej(new Error(`HTTP ${r.statusCode} ${url}`))); }).on('error', rej));
(async () => {
  const tree = JSON.parse(await get(`https://api.github.com/repos/${SRC}/git/trees/main?recursive=1`, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' })).tree;
  let n = 0, bytes = 0;
  for (const m of MAP) {
    if (WHAT !== 'all' && m.kind !== WHAT) continue;
    const files = tree.filter(t => t.type === 'blob' && t.path.startsWith(m.from));
    console.log(`${m.from} → ${m.to}: ${files.length} files`);
    for (const f of files) {
      const dest = path.join(m.to, f.path.slice(m.from.length)); fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) continue;
      const buf = await get(`https://raw.githubusercontent.com/${SRC}/main/${f.path}`); fs.writeFileSync(dest, buf); n++; bytes += buf.length;
      await new Promise(r => setTimeout(r, 40));
    }
  }
  // ledgers were derived under the old paths — rewrite the two path-bearing fields so they read true here
  for (const slug of ['pixel-lions', 'tla-locks', 'adao']) { const p = path.join(slug, 'ledger', 'index.json'); if (!fs.existsSync(p)) continue; const ix = JSON.parse(fs.readFileSync(p, 'utf8')); ix.product = `${slug}/ledger`; ix.collection = slug; ix.imported_from = 'thealliancedao/tla-core (2026-09-12 backfill); coverage sources keep their original tla-core names'; ix.forward_stream = `org-nft-flows-${slug} (Render) → ${slug}/raw/forward + this ledger`; fs.writeFileSync(p, JSON.stringify(ix, null, 1) + '\n'); }
  console.log(`imported ${n} files, ${(bytes / 1048576).toFixed(1)} MB`);
  console.log('\nPURGE in tla-core after this lands (owner, web UI): nfts/pixel · nfts/raw/pixel · nfts/tla-locks · nfts/adao/ledger · archive/fcd/pixel-collection · archive/fcd/pixel-voting · archive/fcd/pixel-enterprise · docs/curated/nft-collections.json · .github/scripts/nft-flows · .github/workflows/nft-flows-*.yml · fcd-harvest.yml presets pixel-*');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
