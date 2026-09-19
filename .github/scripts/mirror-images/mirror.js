'use strict';
// mirror-images/mirror.js 1.0.0 (2026-09-19) — ONE-TIME: copy a collection's images from IPFS onto the site's image CDN
// (Cloudflare Images — the account aDAO already serves from), then point the manifest's images.cdn_pattern at it.
//
// Why: public IPFS gateways refuse a gallery's worth of hot-linked images (ipfs.io 403, dweb.link 429 — HAR 2026-09-19), and
// BBL serves Pixel Lions through a tokened gateway the site must not hardcode. aDAO solved this in 2024 by mirroring to
// Cloudflare Images; every collection gets the same treatment, once, by this Action.
//
//   env  CF_ACCOUNT_ID · CF_IMAGES_TOKEN (Images: edit) · CF_ACCOUNT_HASH (the imagedelivery.net hash)
//        IPFS_GATEWAY   — a gateway URL template with {cid} and {path}, e.g. https://<pinata-gateway>/ipfs/{cid}/{path}?pinataGatewayToken=…
//                         (a tokened gateway lives in a secret; ipfs.io works only for a handful of files)
//        COLLECTION     — the slug (reads <slug>/collection.json: images.ipfs_cid, supply)
//        FROM / TO      — token id range (default 1 … supply)   ·   PACE_MS (default 150)   ·   DRY=1 to list without uploading
//   out  Cloudflare image id `<slug_underscored>/<id>.png` (aDAO's convention: alliance_dao/<id>.png), variants public · thumb
//        writes <slug>/images/mirror-report.json (per id: ok / exists / failed) — write-once per id, re-runs skip what exists
//        prints the cdn_pattern to put in collection.json: https://imagedelivery.net/<hash>/<slug_underscored>/{id}.png/public
const fs = require('fs'), path = require('path');
const ROOT = process.env.ROOT || process.cwd();
const SLUG = String(process.env.COLLECTION || '').trim(); if (!SLUG) { console.error('COLLECTION missing'); process.exit(2); }
const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN, CF_ACCOUNT_HASH, IPFS_GATEWAY } = process.env;
const DRY = /^1|true$/i.test(String(process.env.DRY || '')); const PACE = Number(process.env.PACE_MS || 150);
if (!DRY && (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN)) { console.error('CF_ACCOUNT_ID + CF_IMAGES_TOKEN required (Images: edit)'); process.exit(2); }
if (!IPFS_GATEWAY || !/\{cid\}/.test(IPFS_GATEWAY) || !/\{path\}/.test(IPFS_GATEWAY)) { console.error('IPFS_GATEWAY must be a template with {cid} and {path}'); process.exit(2); }
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest = rj(path.join(ROOT, SLUG, 'collection.json'));
const cid = manifest.images && manifest.images.ipfs_cid; if (!cid) { console.error(`${SLUG}/collection.json has no images.ipfs_cid`); process.exit(2); }
const idPrefix = SLUG.replace(/-/g, '_');
const from = Number(process.env.FROM || 1), to = Number(process.env.TO || manifest.supply);
const reportPath = path.join(ROOT, SLUG, 'images', 'mirror-report.json'); fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const report = fs.existsSync(reportPath) ? rj(reportPath) : { collection: SLUG, cdn_id_prefix: idPrefix, cid, ids: {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchImage(id) {
  const url = IPFS_GATEWAY.replace('{cid}', cid).replace('{path}', `${id}.png`);
  for (let a = 1; a <= 4; a++) { const r = await fetch(url); if (r.ok) return Buffer.from(await r.arrayBuffer()); if (r.status === 404) throw new Error('404 at the gateway'); await sleep(1000 * a); }
  throw new Error('gateway did not answer');
}
async function upload(id, buf) {
  const fd = new FormData(); fd.append('id', `${idPrefix}/${id}.png`); fd.append('file', new Blob([buf], { type: 'image/png' }), `${id}.png`);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`, { method: 'POST', headers: { Authorization: `Bearer ${CF_IMAGES_TOKEN}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.success) return 'ok';
  if (j.errors && j.errors.some(e => e.code === 5409)) return 'exists';   // already uploaded (write-once)
  throw new Error(`cloudflare ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 200)}`);
}
(async () => {
  let ok = 0, exists = 0, failed = 0, skipped = 0; const t0 = Date.now();
  for (let id = from; id <= to; id++) {
    const key = String(id); if (report.ids[key] && report.ids[key].status !== 'failed') { skipped++; continue; }
    try {
      if (DRY) { console.log(`dry: ${id}.png ← ${IPFS_GATEWAY.replace('{cid}', cid).replace('{path}', id + '.png').replace(/\?.*$/, '?…')}`); continue; }
      const buf = await fetchImage(id); const st = await upload(id, buf);
      report.ids[key] = { status: st, bytes: buf.length, at: new Date().toISOString() }; if (st === 'ok') ok++; else exists++;
    } catch (e) { report.ids[key] = { status: 'failed', error: e.message, at: new Date().toISOString() }; failed++; console.warn(`  ⚠ ${id}: ${e.message}`); }
    if (id % 100 === 0) { fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n'); console.log(`  ${id}/${to} · ok ${ok} · exists ${exists} · failed ${failed} · skipped ${skipped} · ${Math.round((Date.now() - t0) / 1000)}s`); }
    await sleep(PACE);
  }
  report.updatedAt = new Date().toISOString(); report.cdn_pattern = CF_ACCOUNT_HASH ? `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${idPrefix}/{id}.png/public` : null;
  if (!DRY) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
  console.log(`\nmirror ${SLUG}: ok ${ok} · already there ${exists} · failed ${failed} · skipped ${skipped}`);
  if (report.cdn_pattern) console.log(`→ set images.cdn_pattern in ${SLUG}/collection.json to: ${report.cdn_pattern} (variant public; thumb for cards)`);
  process.exit(failed && !ok && !exists ? 1 : 0);
})();
