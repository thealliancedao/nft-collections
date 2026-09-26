'use strict';
// mirror-images/mirror.js 1.2.0 (2026-09-26) — ONE-TIME: copy a collection's images from IPFS to somewhere the site can serve
// them from, then point the manifest's images.cdn_pattern at it. Two targets:
//   TARGET=repo (default, no account needed): the files land in THIS repo at <slug>/images/<id>.png (the collection's own folder,
//     per doctrine) and are served through jsDelivr's GitHub CDN (https://cdn.jsdelivr.net/gh/thealliancedao/nft-collections@main/
//     <slug>/images/{id}.png — cached at the edge, free) with raw.githubusercontent.com as the fallback. The workflow commits in
//     batches of 500 so a push never carries more than a few tens of MB.
//   TARGET=cloudflare: Cloudflare Images (the account aDAO's images live on) — needs CF_ACCOUNT_ID · CF_IMAGES_TOKEN · CF_ACCOUNT_HASH.
//
// Why: public IPFS gateways refuse a gallery's worth of hot-linked images (ipfs.io 403, dweb.link 429 — HAR 2026-09-19), and
// BBL serves Pixel Lions through a tokened gateway the site must not hardcode. aDAO solved this in 2024 by mirroring to
// Cloudflare Images; every collection gets the same treatment, once, by this Action.
//
// 1.2.0 — a second mode for collections whose tokens each carry their OWN token_uri (Burning Lions: one ipfs:// file per token,
// animated media). Set images.mode = "token_uri" in <slug>/collection.json and the script, per token id:
//   1. asks the chain for nft_info (images.lcd or the default Terra LCDs) → token_uri
//   2. fetches token_uri through every gateway it knows until one answers (the IPFS_GATEWAY secret first when it is a {cid}
//      gateway, then images.gateways, then the public list below). A JSON answer is the metadata; anything else IS the media.
//   3. fetches the metadata's image and animation_url the same way, sniffs each file's real type from its bytes and keeps its
//      extension (gif, png, webp, jpg, mp4, webm, …) — nothing is converted, an animation stays an animation
//   4. when IPFS gives nothing, falls back to images.proxies (a marketplace image proxy, {contract} + {id}) for a still, labeled
//   writes <slug>/images/<id>.<ext> (the image) · <slug>/images/<id>.anim.<ext> (the animation, when separate)
//          <slug>/metadata/tokens/<id>.json (the token's own metadata, verbatim) · <slug>/metadata/metadata.json (all tokens, one
//          row each: id, name, description, attributes, image_file, animation_file, media kinds, sources) — what the site reads
//   Target repo only (Cloudflare Images takes stills, not video).
//
//   env  CF_ACCOUNT_ID · CF_IMAGES_TOKEN (Images: edit) · CF_ACCOUNT_HASH (the imagedelivery.net hash)
//        IPFS_GATEWAY   — a URL template: {cid} + {path} for a gateway (https://<pinata-gateway>/ipfs/{cid}/{path}?pinataGatewayToken=…),
//                         or {id} for an image proxy (https://nft.openfields.app/api/image/<contract>/{id}); a token lives in a secret only.
//                         Required in png mode; optional in token_uri mode (used only when it is a {cid} gateway).
//        COLLECTION     — the slug (reads <slug>/collection.json: images.ipfs_cid, supply, images.mode)
//        FROM / TO      — token id range (default 1 … supply)   ·   PACE_MS (default 150)   ·   DRY=1 to list without uploading
//   out  Cloudflare image id `<slug_underscored>/<id>.png` (aDAO's convention: alliance_dao/<id>.png), variants public · thumb
//        writes <slug>/images/mirror-report.json (per id: ok / exists / failed) — write-once per id, re-runs skip what exists
//        prints the cdn_pattern to put in collection.json: https://imagedelivery.net/<hash>/<slug_underscored>/{id}.png/public
const fs = require('fs'), path = require('path');
const VERSION = '1.2.0';
const ROOT = process.env.ROOT || process.cwd();
const SLUG = String(process.env.COLLECTION || '').trim(); if (!SLUG) { console.error('COLLECTION missing'); process.exit(2); }
const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN, CF_ACCOUNT_HASH, IPFS_GATEWAY } = process.env;
const TARGET = String(process.env.TARGET || 'repo').toLowerCase();
const DRY = /^1|true$/i.test(String(process.env.DRY || '')); const PACE = Number(process.env.PACE_MS || 150);
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest = rj(path.join(ROOT, SLUG, 'collection.json'));
const IMG = manifest.images || {};
const MODE = String(IMG.mode || 'cid').toLowerCase();
if (TARGET !== 'repo' && TARGET !== 'cloudflare') { console.error('TARGET must be repo or cloudflare'); process.exit(2); }
if (MODE === 'token_uri' && TARGET !== 'repo') { console.error('images.mode token_uri mirrors to the repo only (animated media; Cloudflare Images takes stills)'); process.exit(2); }
if (!DRY && TARGET === 'cloudflare' && (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN)) { console.error('CF_ACCOUNT_ID + CF_IMAGES_TOKEN required for TARGET=cloudflare (Images: edit)'); process.exit(2); }
if (MODE !== 'token_uri' && (!IPFS_GATEWAY || !(/\{path\}/.test(IPFS_GATEWAY) || /\{id\}/.test(IPFS_GATEWAY)))) { console.error('IPFS_GATEWAY must be a URL template with {path} (or {id}); {cid} optional — e.g. a tokened gateway https://…/ipfs/{cid}/{path}?token=…, or a marketplace image proxy https://…/api/image/<contract>/{id}'); process.exit(2); }
const cid = IMG.ipfs_cid || null; if (MODE !== 'token_uri' && !cid) { console.error(`${SLUG}/collection.json has no images.ipfs_cid`); process.exit(2); }
const idPrefix = SLUG.replace(/-/g, '_');
const from = Number(process.env.FROM || 1), to = Number(process.env.TO || manifest.supply);
const reportPath = path.join(ROOT, SLUG, 'images', 'mirror-report.json'); fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const report = fs.existsSync(reportPath) ? rj(reportPath) : { collection: SLUG, target: TARGET, mode: MODE, cdn_id_prefix: idPrefix, cid, ids: {} };
const REPO = process.env.GITHUB_REPOSITORY || 'thealliancedao/nft-collections';
const imgDir = path.join(ROOT, SLUG, 'images'); fs.mkdirSync(imgDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hide = (u) => String(u).replace(/\?.*$/, '?…');   // never print a gateway token

// ---------------------------------------------------------------- png mode (one folder CID, <id>.png inside) — unchanged from 1.1.0
async function fetchImage(id) {
  const url = IPFS_GATEWAY.replace('{cid}', cid).replace('{path}', `${id}.png`).replace('{id}', String(id));
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

// ---------------------------------------------------------------- token_uri mode helpers
const LCDS = (process.env.LCDS ? process.env.LCDS.split(',') : (Array.isArray(IMG.lcd) && IMG.lcd.length ? IMG.lcd : ['https://terra-lcd.publicnode.com', 'https://terra-api.polkachu.com', 'https://lcd-terra.tfl.foundation'])).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const PUBLIC_GATEWAYS = ['https://ipfs.io/ipfs/{cid}/{path}', 'https://dweb.link/ipfs/{cid}/{path}', 'https://w3s.link/ipfs/{cid}/{path}', 'https://nftstorage.link/ipfs/{cid}/{path}', 'https://gateway.pinata.cloud/ipfs/{cid}/{path}', 'https://4everland.io/ipfs/{cid}/{path}', 'https://ipfs.filebase.io/ipfs/{cid}/{path}', 'https://cloudflare-ipfs.com/ipfs/{cid}/{path}'];
const GATEWAYS = [].concat(IPFS_GATEWAY && /\{cid\}/.test(IPFS_GATEWAY) ? [IPFS_GATEWAY] : [], Array.isArray(IMG.gateways) ? IMG.gateways : [], process.env.GATEWAYS ? process.env.GATEWAYS.split(',') : PUBLIC_GATEWAYS).filter(Boolean);
const PROXIES = Array.isArray(IMG.proxies) ? IMG.proxies : [];
const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 45000);
async function get(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'thealliancedao-mirror-images' } }); if (!r.ok) return { error: 'HTTP ' + r.status }; return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' }; }
  catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; } finally { clearTimeout(t); }
}
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }
async function nftInfo(id) {
  const errs = [];
  for (const h of LCDS) { const r = await get(`${h}/cosmwasm/wasm/v1/contract/${manifest.nft_contract}/smart/${b64({ nft_info: { token_id: String(id) } })}`); if (r.error) { errs.push(h.replace(/^https?:\/\//, '') + ' ' + r.error); continue; } try { return JSON.parse(r.buf.toString('utf8')).data; } catch (e) { errs.push(h + ' bad json'); } }
  throw new Error('nft_info: ' + errs.join(' · '));
}
// ipfs://<cid>/<path> · https://<any>/ipfs/<cid>/<path> · a bare CID → { cid, path }; anything else is a plain URL
function ipfsParts(u) {
  const s = String(u || '').trim(); let m;
  if ((m = s.match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)\/?([^?#]*)/i))) return { cid: m[1], path: m[2] || '' };
  if ((m = s.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)\/?([^?#]*)/i))) return { cid: m[1], path: m[2] || '' };
  if ((m = s.match(/^https?:\/\/([a-z0-9]{50,})\.ipfs\.[^/]+\/?([^?#]*)/i))) return { cid: m[1], path: m[2] || '' };
  if (/^(Qm[1-9A-Za-z]{44}|b[a-z2-7]{50,})$/.test(s)) return { cid: s, path: '' };
  return null;
}
function fill(tpl, p) { let u = tpl.replace('{cid}', p.cid); u = p.path ? u.replace('{path}', p.path) : u.replace(/\/?\{path\}/, ''); return u; }
async function resolve(uri) {   // → { buf, type, via } or throws with every attempt listed
  const p = ipfsParts(uri); const errs = [];
  if (!p) { if (/^data:/.test(uri)) { const m = uri.match(/^data:([^;,]*)(;base64)?,(.*)$/s); return { buf: Buffer.from(m[2] ? m[3] : decodeURIComponent(m[3]), m[2] ? 'base64' : 'utf8'), type: m[1], via: 'data uri' }; }
    for (let a = 1; a <= 2; a++) { const r = await get(uri); if (!r.error) return Object.assign(r, { via: hide(uri) }); errs.push(r.error); await sleep(1500); } throw new Error(hide(uri) + ': ' + errs.join(' · ')); }
  for (const g of GATEWAYS) { const u = fill(g, p); const r = await get(u); if (!r.error && r.buf.length) return Object.assign(r, { via: hide(u).replace(p.cid, '{cid}') }); errs.push(u.replace(/^https?:\/\//, '').split('/')[0] + ' ' + (r.error || 'empty')); }
  throw new Error('no gateway served ' + p.cid.slice(0, 14) + '… — ' + errs.join(' · '));
}
function sniff(buf, type) {
  const h = buf.subarray(0, 16), s = h.toString('latin1');
  if (s.startsWith('GIF8')) return ['gif', 'image'];
  if (h[0] === 0x89 && s.slice(1, 4) === 'PNG') return /acTL/.test(buf.subarray(0, 256).toString('latin1')) ? ['png', 'image-animated'] : ['png', 'image'];
  if (h[0] === 0xff && h[1] === 0xd8) return ['jpg', 'image'];
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return /ANIM/.test(buf.subarray(0, 64).toString('latin1')) ? ['webp', 'image-animated'] : ['webp', 'image'];
  if (s.slice(4, 8) === 'ftyp') return /qt {2}/.test(s.slice(8, 12)) ? ['mov', 'video'] : ['mp4', 'video'];
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return ['webm', 'video'];
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg/.test(head))) return ['svg', 'image'];
  if (head.startsWith('{') || head.startsWith('[')) return ['json', 'json'];
  if (/^<!doctype html|^<html/i.test(head)) return ['html', 'html'];
  if (/gltf|glb/.test(type) || s.startsWith('glTF')) return ['glb', 'model'];
  if (/^image\//.test(type)) return [type.split('/')[1].split(';')[0].replace('jpeg', 'jpg'), 'image'];
  if (/^video\//.test(type)) return [type.split('/')[1].split(';')[0], 'video'];
  return ['bin', 'unknown'];
}
function save(id, suffix, got) {
  const [ext, kind] = sniff(got.buf, got.type); const file = `${id}${suffix}.${ext}`;
  for (const old of fs.readdirSync(imgDir)) if (old !== file && old.startsWith(`${id}${suffix}.`) && !old.startsWith(`${id}${suffix}.anim`)) fs.unlinkSync(path.join(imgDir, old));
  fs.writeFileSync(path.join(imgDir, file), got.buf); return { file, kind, ext, bytes: got.buf.length, via: got.via };
}
async function mirrorTokenUri(id) {
  const info = await nftInfo(id); const uri = info && info.token_uri; const ext = (info && info.extension) || {};
  const row = { id: String(id), token_uri: uri || null, name: ext.name || null, description: ext.description || null, attributes: Array.isArray(ext.attributes) ? ext.attributes : null, image_file: null, animation_file: null, image_kind: null, animation_kind: null, sources: {} };
  let meta = null, errs = [];
  const metaUri = uri || null;
  if (metaUri) {
    try { const got = await resolve(metaUri); const [x, kind] = sniff(got.buf, got.type);
      if (kind === 'json') { meta = JSON.parse(got.buf.toString('utf8')); fs.mkdirSync(path.join(ROOT, SLUG, 'metadata', 'tokens'), { recursive: true }); fs.writeFileSync(path.join(ROOT, SLUG, 'metadata', 'tokens', `${id}.json`), JSON.stringify(meta, null, 1) + '\n'); row.sources.metadata = got.via; }
      else { const s = save(id, '', got); row.image_file = s.file; row.image_kind = s.kind; row.sources.image = s.via + ' (token_uri is the media itself)'; }
    } catch (e) { errs.push('token_uri: ' + e.message); }
  }
  if (meta) {
    row.name = meta.name || row.name; row.description = meta.description || row.description; row.attributes = Array.isArray(meta.attributes) ? meta.attributes : row.attributes;
    const imageUri = meta.image || meta.image_url || (meta.properties && meta.properties.image) || ext.image || null;
    const animUri = meta.animation_url || meta.animation || (meta.properties && meta.properties.animation_url) || ext.animation_url || null;
    if (imageUri) { try { const s = save(id, '', await resolve(imageUri)); row.image_file = s.file; row.image_kind = s.kind; row.sources.image = s.via; row.image_uri = imageUri; } catch (e) { errs.push('image: ' + e.message); } }
    if (animUri && animUri !== imageUri) { try { const s = save(id, '.anim', await resolve(animUri)); row.animation_file = s.file; row.animation_kind = s.kind; row.sources.animation = s.via; row.animation_uri = animUri; } catch (e) { errs.push('animation_url: ' + e.message); } }
  } else if (!row.image_file && ext.image) { try { const s = save(id, '', await resolve(ext.image)); row.image_file = s.file; row.image_kind = s.kind; row.sources.image = s.via; } catch (e) { errs.push('extension.image: ' + e.message); } }
  if (!row.image_file) for (const px of PROXIES) {   // a marketplace's cached still — labeled, never mistaken for the original
    const u = px.replace('{contract}', manifest.nft_contract).replace('{id}', String(id)); const r = await get(u);
    if (!r.error && r.buf.length) { const s = save(id, '', Object.assign(r, { via: hide(u) })); row.image_file = s.file; row.image_kind = s.kind; row.sources.image = s.via + ' (marketplace proxy — a cached copy, not the IPFS original)'; break; }
    errs.push('proxy ' + u.replace(/^https?:\/\//, '').split('/')[0] + ' ' + r.error);
  }
  if (errs.length) row.errors = errs;
  return row;
}
function writeMetadataIndex(rows) {
  const p = path.join(ROOT, SLUG, 'metadata', 'metadata.json'); fs.mkdirSync(path.dirname(p), { recursive: true });
  const old = fs.existsSync(p) ? rj(p) : null; const by = {}; (old && Array.isArray(old.tokens) ? old.tokens : []).forEach(t => { by[t.id] = t; });
  rows.forEach(r => { const prev = by[r.id] || {}; by[r.id] = Object.assign({}, prev, r, { image_file: r.image_file || prev.image_file || null, animation_file: r.animation_file || prev.animation_file || null }); });
  const tokens = Object.values(by).sort((a, b) => Number(a.id) - Number(b.id));
  const doc = { collection: SLUG, contract: manifest.nft_contract, engine: 'mirror-images ' + VERSION, updatedAt: new Date().toISOString(),
    media_base: `https://cdn.jsdelivr.net/gh/${REPO}@main/${SLUG}/images/`, media_fallback_base: `https://raw.githubusercontent.com/${REPO}/main/${SLUG}/images/`,
    note: 'one row per token, mirrored from each token_uri; image_file / animation_file are file names under media_base, typed by their bytes (gif/png/webp = <img>, mp4/webm/mov = <video>). A source ending "(marketplace proxy …)" is a cached still, not the original.', tokens };
  fs.writeFileSync(p, JSON.stringify(doc, null, 1) + '\n'); return tokens;
}

(async () => {
  let ok = 0, exists = 0, failed = 0, skipped = 0; const t0 = Date.now();
  if (MODE === 'token_uri') {
    console.log(`mirror ${SLUG} ${VERSION} · token_uri mode · ids ${from}…${to} · LCDs ${LCDS.length} · gateways ${GATEWAYS.length}${IPFS_GATEWAY && /\{cid\}/.test(IPFS_GATEWAY) ? ' (secret first)' : ''} · proxies ${PROXIES.length}`);
    const rows = [];
    for (let id = from; id <= to; id++) {
      const key = String(id); const prev = report.ids[key];
      if (prev && prev.status === 'ok' && (!prev.animation_expected || prev.animation_file)) { skipped++; continue; }
      if (DRY) { try { const i = await nftInfo(id); console.log(`dry: ${id} ← ${i && i.token_uri}`); } catch (e) { console.log(`dry: ${id} ✗ ${e.message}`); } continue; }
      try { const row = await mirrorTokenUri(id); rows.push(row);
        const st = row.image_file ? (row.errors ? 'partial' : 'ok') : 'failed';
        report.ids[key] = { status: st, image_file: row.image_file, image_kind: row.image_kind, animation_file: row.animation_file, animation_kind: row.animation_kind, animation_expected: !!row.animation_uri, token_uri: row.token_uri, sources: row.sources, errors: row.errors || undefined, at: new Date().toISOString() };
        if (st === 'failed') { failed++; console.warn(`  ⚠ ${id}: ${(row.errors || []).join(' | ')}`); } else { ok++; console.log(`  ${id}: ${row.name || ''} · image ${row.image_file} (${row.image_kind})${row.animation_file ? ' · animation ' + row.animation_file + ' (' + row.animation_kind + ')' : ''}${row.errors ? ' · ' + row.errors.join(' | ') : ''}`); }
      } catch (e) { report.ids[key] = { status: 'failed', error: e.message, at: new Date().toISOString() }; failed++; console.warn(`  ⚠ ${id}: ${e.message}`); }
      await sleep(PACE);
    }
    if (!DRY) { const all = writeMetadataIndex(rows); report.updatedAt = new Date().toISOString(); report.mode = MODE; report.media_base = `https://cdn.jsdelivr.net/gh/${REPO}@main/${SLUG}/images/`; report.metadata_index = `${SLUG}/metadata/metadata.json`; fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n'); console.log(`\nmetadata index: ${all.length} tokens → ${SLUG}/metadata/metadata.json`); }
    console.log(`mirror ${SLUG}: ok ${ok} · failed ${failed} · skipped ${skipped} · ${Math.round((Date.now() - t0) / 1000)}s`);
    if (failed) console.log('→ a failed id means no gateway and no proxy served it. Pinning the files anywhere (or adding a gateway that has them to the IPFS_GATEWAY secret / images.gateways) and re-running picks up only what is missing.');
    process.exit(failed && !ok ? 1 : 0);
  }
  for (let id = from; id <= to; id++) {
    const key = String(id); if (report.ids[key] && report.ids[key].status !== 'failed') { skipped++; continue; }
    try {
      if (DRY) { console.log(`dry: ${id}.png ← ${hide(IPFS_GATEWAY.replace('{cid}', cid).replace('{path}', id + '.png').replace('{id}', String(id)))}`); continue; }
      let st;
      if (TARGET === 'repo') { const fp = path.join(imgDir, `${id}.png`); if (fs.existsSync(fp) && fs.statSync(fp).size > 0) st = 'exists'; else { const buf = await fetchImage(id); if (!buf.length) throw new Error('empty file'); fs.writeFileSync(fp, buf); st = 'ok'; report.ids[key] = { status: st, bytes: buf.length, at: new Date().toISOString() }; if (st === 'ok') ok++; await sleep(PACE); continue; } report.ids[key] = { status: st, at: new Date().toISOString() }; exists++; continue; }
      const buf = await fetchImage(id); st = await upload(id, buf);
      report.ids[key] = { status: st, bytes: buf.length, at: new Date().toISOString() }; if (st === 'ok') ok++; else exists++;
    } catch (e) { report.ids[key] = { status: 'failed', error: e.message, at: new Date().toISOString() }; failed++; console.warn(`  ⚠ ${id}: ${e.message}`); }
    if (id % 100 === 0) { fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n'); console.log(`  ${id}/${to} · ok ${ok} · exists ${exists} · failed ${failed} · skipped ${skipped} · ${Math.round((Date.now() - t0) / 1000)}s`); }
    await sleep(PACE);
  }
  report.updatedAt = new Date().toISOString();
  if (TARGET === 'repo') { report.cdn_pattern = `https://cdn.jsdelivr.net/gh/${REPO}@main/${SLUG}/images/{id}.png`; report.cdn_fallback = `https://raw.githubusercontent.com/${REPO}/main/${SLUG}/images/{id}.png`; }
  else report.cdn_pattern = CF_ACCOUNT_HASH ? `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${idPrefix}/{id}.png/public` : null;
  if (!DRY) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');
  console.log(`\nmirror ${SLUG}: ok ${ok} · already there ${exists} · failed ${failed} · skipped ${skipped}`);
  if (report.cdn_pattern) console.log(`→ set images.cdn_pattern in ${SLUG}/collection.json to: ${report.cdn_pattern}${report.cdn_fallback ? `\n→ and images.cdn_fallback to: ${report.cdn_fallback}` : ' (variant public; thumb for cards)'}`);
  process.exit(failed && !ok && !exists ? 1 : 0);
})();
