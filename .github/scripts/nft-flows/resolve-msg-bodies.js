'use strict';
// resolve-msg-bodies.js — nft-flows 1.5.0 (2026-09-19, CHANGES_PENDING B.1: Boost list prices · Atrium list denoms · DAODAO
// unstake token ids). Raw walk parts archived EVENTS only; three things the classifier needs live only in the MESSAGE BODY:
//   list on Boost   → price_reason msg_body_not_archived:price   (launch-nft/setup emits no price)
//   list on Atrium  → price_reason msg_body_not_archived:denom   (list_nft emits price but no denom)
//   unstake (DAODAO) → token_id null, "token ids live in the msg body"
// This ONE-TIME resolver reads the ledger for exactly those rows, fetches each tx by hash from the RPC (/tx?hash=0x…; the
// public node first, the archive node — secret ARCHIVE_RPC — for anything it no longer holds), decodes the bodies with
// platform-crons/nfts/nft-flows/lib/tx-body.js (required from the run-time checkout, CRONS_DIR — one decoder, no copy) and
// writes <slug>/raw/msg-bodies.json: { txhash: { height, messages, fetched_from, at } }, write-once per hash (re-runs skip
// what is there; a hash neither node returns is recorded as failed with the reason, never invented). derive 1.2.1 attaches
// these to any archived tx that has no `m` of its own; walks from 1.5.0 decode bodies at walk time, so this backlog is finite.
//   env COLLECTION (slug) · ARCHIVE_RPC (secret) · RPC_URL (public, default terra-rpc.publicnode.com) · CRONS_DIR · DRY=1 · PACE_MS (250)
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');
const ROOT = process.env.ROOT || process.cwd(); const SLUG = String(process.env.COLLECTION || '').trim(); if (!SLUG) { console.error('COLLECTION missing'); process.exit(2); }
const DRY = /^1|true$/i.test(String(process.env.DRY || '')); const PACE = Number(process.env.PACE_MS || 250);
const clean = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/status$/, '');
const PUBLIC = clean(process.env.RPC_URL || 'https://terra-rpc.publicnode.com'), ARCHIVE = clean(process.env.ARCHIVE_RPC);
const CRONS = process.env.CRONS_DIR || path.join(ROOT, '_crons');
const libp = path.join(CRONS, 'nfts/nft-flows/lib/tx-body.js'); if (!fs.existsSync(libp)) { console.error(`FATAL: ${libp} missing — the workflow checks platform-crons out at _crons (CRONS_DIR); the decoder has one home`); process.exit(2); }
const { decodeTxMessages } = require(libp);
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8')); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpGet(url, t = 20000) { return new Promise((resolve, reject) => { const u = new URL(url); const r = (u.protocol === 'http:' ? http : https).get(url, { headers: { 'User-Agent': 'tla-nft-flows-resolve-msg-bodies' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 120)}`)); } }); }); r.on('error', reject); r.setTimeout(t, () => r.destroy(new Error('idle-timeout'))); }); }
async function fetchTx(base, hash) {   // Tendermint RPC: {result:{hash,height,tx:<base64>}} or {error:{data:"tx (…) not found"}}
  let last; for (let a = 1; a <= 3; a++) { try { const r = await httpGet(`${base}/tx?hash=0x${hash}`); if (r.json && r.json.result && r.json.result.tx) return r.json.result; if (r.json && r.json.error && /not found/i.test(JSON.stringify(r.json.error))) return null; throw new Error(JSON.stringify(r.json && r.json.error || r.json).slice(0, 160)); } catch (e) { last = e; await sleep(600 * a); } }
  throw last;
}
(async () => {
  const t0 = Date.now(); const base = path.join(ROOT, SLUG, 'ledger'); if (!fs.existsSync(base)) { console.error(`${SLUG}/ledger missing`); process.exit(2); }
  const need = new Map();   // txhash → { height, why:[…] }
  for (const y of fs.readdirSync(base).filter(d => /^\d{4}$/.test(d)).sort()) for (const m of fs.readdirSync(path.join(base, y)).filter(f => /^\d\d\.json$/.test(f)).sort()) for (const r of rj(path.join(base, y, m))) {
    if (r.superseded_by) continue;
    const why = r.kind === 'list' && /^msg_body_not_archived/.test(String(r.price_reason || '')) ? `list:${r.venue}:${r.price_reason}` : r.kind === 'unstake' && r.token_id == null ? 'unstake:token_ids' : null;
    if (!why) continue; const e = need.get(r.txhash) || { height: r.height, why: new Set() }; e.why.add(why); need.set(r.txhash, e);
  }
  const outp = path.join(ROOT, SLUG, 'raw', 'msg-bodies.json');
  const doc = fs.existsSync(outp) ? rj(outp) : { collection: SLUG, note: 'message bodies fetched by hash for archived txs whose raw part carries events only; derive attaches them (tx.messages) when the part has none. write-once per hash.', bodies: {}, failed: {} };
  const todo = [...need.entries()].filter(([h]) => !doc.bodies[h]).sort((a, b) => a[1].height - b[1].height);
  const whyCount = {}; for (const [, e] of need) for (const w of e.why) whyCount[w] = (whyCount[w] || 0) + 1;
  console.log(`${SLUG}: ${need.size} tx(s) need a body ${JSON.stringify(whyCount)} · ${need.size - todo.length} already resolved · ${todo.length} to fetch · public ${PUBLIC} · archive ${ARCHIVE ? 'set' : 'NOT SET (public window only, ~2.5 months)'}${DRY ? ' · DRY' : ''}`);
  let ok = 0, fail = 0, fromPub = 0, fromArc = 0;
  for (const [h, e] of todo) {
    if (DRY) { console.log(`dry: ${h.slice(0, 12)} h${e.height} ${[...e.why].join(',')}`); continue; }
    try {
      let res = null, from = null;
      try { res = await fetchTx(PUBLIC, h); from = 'public'; } catch (err) { console.warn(`  public rpc failed for ${h.slice(0, 12)}: ${err.message}`); }
      if (!res && ARCHIVE) { res = await fetchTx(ARCHIVE, h); from = 'archive'; }
      if (!res) { doc.failed[h] = { height: e.height, why: [...e.why], error: ARCHIVE ? 'not found on public or archive rpc' : 'not found on public rpc (no ARCHIVE_RPC)', at: new Date().toISOString() }; fail++; console.warn(`  ⚠ ${h.slice(0, 12)} h${e.height}: not found`); continue; }
      const messages = decodeTxMessages(res.tx);
      if (!messages.length) throw new Error('decoded 0 messages');
      doc.bodies[h] = { height: Number(res.height) || e.height, messages, fetched_from: from, at: new Date().toISOString() }; delete doc.failed[h]; ok++; if (from === 'public') fromPub++; else fromArc++;
    } catch (err) { doc.failed[h] = { height: e.height, why: [...e.why], error: err.message.slice(0, 200), at: new Date().toISOString() }; fail++; console.warn(`  ⚠ ${h.slice(0, 12)} h${e.height}: ${err.message.slice(0, 120)}`); }
    if ((ok + fail) % 25 === 0) { if (!DRY) { fs.mkdirSync(path.dirname(outp), { recursive: true }); fs.writeFileSync(outp, JSON.stringify(doc, null, 1) + '\n'); } console.log(`  ${ok + fail}/${todo.length} · ok ${ok} (public ${fromPub} · archive ${fromArc}) · failed ${fail} · ${Math.round((Date.now() - t0) / 1000)}s`); }
    await sleep(PACE);
  }
  if (!DRY) { doc.updatedAt = new Date().toISOString(); doc.resolved = Object.keys(doc.bodies).length; doc.failed_count = Object.keys(doc.failed).length; fs.mkdirSync(path.dirname(outp), { recursive: true }); fs.writeFileSync(outp, JSON.stringify(doc, null, 1) + '\n'); }
  console.log(`resolve-msg-bodies ${SLUG}: ok ${ok} (public ${fromPub} · archive ${fromArc}) · failed ${fail} · on file ${Object.keys(doc.bodies).length} bodies, ${Object.keys(doc.failed).length} failed · ${Date.now() - t0} ms${DRY ? ' (DRY — nothing written)' : ''}`);
  if (todo.length && !ok && !DRY) process.exit(1);   // asked for bodies, got none — a node problem, not a clean run
})().catch(e => { console.error('FATAL', e); process.exit(1); });
