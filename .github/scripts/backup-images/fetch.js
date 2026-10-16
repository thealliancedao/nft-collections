'use strict';
// backup-images/fetch.js 1.0.0 (2026-10-16) — a safe copy of a collection's ORIGINAL pictures, for when IPFS hosts go away (2026-10-16:
// w3s.link, nftstorage.link, ipfs.io and dweb.link all answer 429 "service worker gateway only"; only DAO DAO's gateway still serves).
// Downloads ids FROM..TO of <slug>'s folder CID as-is (no re-encoding) into OUT/, checks each is a real PNG, and writes
// OUT/manifest.json (id → bytes, sha256). The workflow packs each range into a .tar and keeps it as a GitHub Release asset — not in
// git, so the repo stays light (aDAO: 10,000 × ~95 KB ≈ 1 GB). Paced, 4 at a time.
//   env  CID · FROM · TO · OUT · GATEWAYS (comma list of {cid}/{path} templates; default DAO DAO's)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const CID = process.env.CID, FROM = Number(process.env.FROM), TO = Number(process.env.TO), OUT = process.env.OUT;
const GW = (process.env.GATEWAYS || 'https://ipfs.daodao.zone/ipfs/{cid}/{path}').split(',').map((s) => s.trim()).filter(Boolean);
if (!CID || !FROM || !TO || !OUT) { console.error('CID, FROM, TO, OUT required'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
async function grab(id) {
  for (let round = 0; round < 4; round++) for (const g of GW) {
    try {
      const r = await fetch(g.replace('{cid}', CID).replace('{path}', `${id}.png`), { signal: AbortSignal.timeout(45_000), headers: { 'User-Agent': 'aDAO backup-images/1.0 (one-off)' } });
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 8 && b.subarray(0, 4).equals(PNG)) return b; }
    } catch { /* next */ }
    await sleep(2000 * (round + 1));
  }
  return null;
}
(async () => {
  const man = { cid: CID, from: FROM, to: TO, made_at: new Date().toISOString(), files: {}, failed: [] };
  let next = FROM;
  const worker = async () => { while (next <= TO) { const id = next++; const b = await grab(id);
    if (!b) { man.failed.push(id); console.log('failed', id); continue; }
    fs.writeFileSync(path.join(OUT, `${id}.png`), b); man.files[id] = { bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; await sleep(100); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(man, null, 1) + '\n');
  const n = Object.keys(man.files).length, mb = Object.values(man.files).reduce((t, f) => t + f.bytes, 0) / 1e6;
  console.log(`${FROM}-${TO}: ${n} saved (${mb.toFixed(1)} MB), ${man.failed.length} failed`);
  if (man.failed.length) process.exitCode = 1;
})();
