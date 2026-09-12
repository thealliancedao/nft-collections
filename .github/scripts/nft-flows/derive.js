'use strict';
// derive.js — nft-flows derive 1.0 (SPEC-nft-flows.md). Runs inside the repo checkout (workflow nft-flows-derive.yml):
//   inputs : docs/curated/nft-collections.json · archive/fcd/<label>/part-*.json.gz (FCD era, events + decoded msgs)
//            tla-flows/raw/<from>-<to>/part-*.json.gz (archive walk, events only) · nfts/raw/<collection>/<from>-<to>/part-*.json.gz (nft-flows walk)
//            nfts/adao/snapshots/luna-usd-daily.json (LUNA USD by day, 2022-05-28 →)
//   outputs: nfts/<collection>/ledger/YYYY/MM.json   (NOT nfts/<collection>/flows/ — that path is the daily state-diff product of nfts/adao/flows.js)  (records; write-once per key, merge idempotent)
//            nfts/<collection>/ledger/primary-sales.json (per token: first exit from the launchpad, price, USD at that day)
//            nfts/<collection>/ledger/lineage.json (locks only: id graph from migrate/split/merge)
//            nfts/<collection>/ledger/index.json (counts, by_kind, coverage ranges, known_gaps — derived from what is on disk, never assumed)
//            nfts/<collection>/ledger/heartbeat.json
// LAWS: blank beats phantom (USD null + reason when no series covers the denom); one canonical file per series; never-shrink
//       (existing records are kept, new keys appended, identical keys skipped); every range in coverage names its source archive.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { classifyNftTx, buildIndex, recordKey, KIND } = require('./classify.js');
const ROOT = process.env.ROOT || process.cwd();
const DRY = /^1|true$/i.test(String(process.env.DRY || ''));
const ONLY = (process.env.COLLECTIONS || '').split(',').map(s => s.trim()).filter(x => x && x !== 'all');   // 'all' = no filter (the workflow dropdown)
const P = (...s) => path.join(ROOT, ...s);
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rgz = (p) => p.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(fs.readFileSync(p))) : rj(p);
const wj = (p, o) => { if (DRY) return; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
const { loadRegistry, layout } = require('./registry.js');
const reg = loadRegistry(ROOT); const idx = buildIndex(reg);
const cols = Object.keys(reg.collections).filter(k => !ONLY.length || ONLY.includes(k));
if (!cols.length) { console.error(`FATAL: no collection matches COLLECTIONS="${process.env.COLLECTIONS}" (registered: ${Object.keys(reg.collections).join(', ')})`); process.exit(1); }

// ---------------------------------------------------------------- price at time
let LUNA = null; try { LUNA = rj(P('_shared', 'luna-usd-daily.json')).daily; } catch { console.warn('_shared/luna-usd-daily.json missing (the workflow fetches it from tla-core) — USD legs will be null'); }
const USDC_IBC = /^ibc\/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB$/;
function usdAt(price, ts) {
  if (!price || price.amount == null || !price.denom) return { usd: null, usd_reason: 'no_price' };
  const day = String(ts).slice(0, 10); const amt = Number(price.amount) / 1e6;
  if (price.denom === 'uluna') { const px = LUNA && LUNA[day]; return px != null ? { usd: amt * px, usd_reason: undefined, luna_usd: px } : { usd: null, usd_reason: 'luna_usd_daily_missing:' + day }; }
  if (USDC_IBC.test(price.denom)) return { usd: amt, usd_reason: undefined };
  return { usd: null, usd_reason: 'no_usd_series_for_denom:' + price.denom };   // LST / SOLID legs: fold in when a dated series exists
}

// ---------------------------------------------------------------- archives on disk
function listParts(dir) { try { const all = fs.readdirSync(dir).filter(f => /^part-\d+\.json(\.gz)?$/.test(f)); const gz = new Set(all.filter(f => f.endsWith('.gz')).map(f => f.slice(0, -3))); return all.filter(f => f.endsWith('.gz') || !gz.has(f)).sort().map(f => path.join(dir, f)); } catch { return []; } }   // harvest writes .json; fcd-compact turns it into .json.gz — read either, never both
function* archives() {
  // everything under the collection's own folder: <slug>/archive/fcd/<label>/part-* and <slug>/raw/<from>-<to>/part-*
  for (const col of Object.keys(reg.collections)) {
    const L = layout(ROOT, col);
    for (const label of (fs.existsSync(L.fcd) ? fs.readdirSync(L.fcd) : [])) for (const f of listParts(path.join(L.fcd, label))) yield { source: `${col}/archive/fcd:${label}`, file: f, kind: 'fcd', owner: col };
    for (const range of (fs.existsSync(L.raw) ? fs.readdirSync(L.raw) : []).filter(d => /^\d+-\d+$/.test(d))) for (const f of listParts(path.join(L.raw, range))) yield { source: `${col}/raw:${range}`, file: f, kind: 'raw', range, walked_for: col, owner: col };
  }
}
function txsOf(a) {
  const d = rgz(a.file);
  if (a.kind === 'fcd') return { txs: d.txs || [], heights: d.height_range || null };
  const txs = d.map(p => ({ txhash: p.x, height: p.h, timestamp: p.t, code: p.c, events: p.e, messages: p.m || undefined }));
  return { txs, heights: txs.length ? [Math.min(...txs.map(t => t.height)), Math.max(...txs.map(t => t.height))] : null };
}

// ---------------------------------------------------------------- run
(async () => {
  const t0 = Date.now();
  const out = {}; for (const c of cols) out[c] = { byMonth: {}, coverage: {}, seen: new Set(), n: 0, dup: 0 };
  // load existing month files (never-shrink)
  for (const c of cols) { const fr = layout(ROOT, c).ledger; if (!fs.existsSync(fr)) continue; for (const y of fs.readdirSync(fr).filter(d => /^\d{4}$/.test(d))) for (const m of fs.readdirSync(path.join(fr, y)).filter(f => /^\d{2}\.json$/.test(f))) { const raw = rj(path.join(fr, y, m)); if (!Array.isArray(raw)) { console.warn(`skip ${fr}/${y}/${m}: not a ledger month file`); continue; } const k = y + '/' + m.slice(0, 2); const recs = []; for (const r of raw) { r.collection = c; const key = recordKey(r); if (out[c].seen.has(key)) { out[c].dropped_dup = (out[c].dropped_dup || 0) + 1; continue; } out[c].seen.add(key); recs.push(r); } out[c].byMonth[k] = recs; /* a ledger is per collection: the slug is the folder; imported months keyed by an older name are the same records */ } }
  let partsRead = 0, txsRead = 0;
  for (const a of archives()) {
    let { txs, heights } = txsOf(a); partsRead++; txsRead += txs.length;
    for (const tx of txs) {
      const recs = classifyNftTx(tx, reg, idx);
      for (const r of recs) {
        const c = r.collection; if (!c || !out[c]) continue;   // venue-level records (deposit/withdraw/offers without a token) are attached below
        r.source = a.source;
        if (r.price) Object.assign(r, usdAt(r.price, r.ts));
        const key = recordKey(r); if (out[c].seen.has(key)) { out[c].dup++; continue; }
        out[c].seen.add(key); const mk = String(r.ts).slice(0, 7).replace('-', '/'); (out[c].byMonth[mk] ||= []).push(r); out[c].n++;
      }
      // venue-level (collection null) → every collection that lists on that venue keeps a copy under its own tree, so a wallet's BBL balance is visible from any collection page
      for (const r of recs.filter(x => !x.collection && x.venue)) for (const c of cols) { const cv = reg.collections[c].venues || []; if (!cv.includes(r.venue)) continue; const rr = Object.assign({}, r, { collection: c, source: a.source }); if (rr.price) Object.assign(rr, usdAt(rr.price, rr.ts)); const key = recordKey(rr); if (out[c].seen.has(key)) continue; out[c].seen.add(key); const mk = String(rr.ts).slice(0, 7).replace('-', '/'); (out[c].byMonth[mk] ||= []).push(rr); out[c].n++; }
    }
    if (a.kind === 'raw' && a.range) { const m = a.range.match(/^(\d+)-(\d+)$/); if (m) { let to = Number(m[2]); try { const r = rj(path.join(path.dirname(a.file), 'report.json')); if (Number.isFinite(r.walked_to)) to = Math.min(to, r.walked_to); } catch { } heights = to >= Number(m[1]) ? [Number(m[1]), to] : null; } }   // walked span per report.walked_to (a budget-stopped walk leaves a tail), never the matched-tx span
    if (heights) for (const c of cols) { const cfg = reg.collections[c].archives || {}; const mine = a.owner === c; const partial = false; /* every archive lives in its owner's folder — no cross-collection partial coverage */ if (mine || partial) { const cv = (out[c].coverage[a.source] ||= { from: Infinity, to: 0, parts: 0, partial: partial ? 'venue txs only — this collection was not in the archive walk watch set' : undefined }); cv.from = Math.min(cv.from, heights[0]); cv.to = Math.max(cv.to, heights[1]); cv.parts++; } }
  }
  for (const c of cols) {
    const o = out[c]; const col = reg.collections[c]; const base = layout(ROOT, c).ledger;
    for (const [mk, recs] of Object.entries(o.byMonth)) { recs.sort((a, b) => a.height - b.height || a.msg_index - b.msg_index); wj(path.join(base, mk + '.json'), recs); }
    const all = Object.values(o.byMonth).flat();
    const byKind = {}; all.forEach(r => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
    // primary sales: first launchpad exit per token (aDAO: the provenance product is authoritative; this file is derived only when a launchpad address is registered)
    const provDir = P(c, 'provenance', 'tokens');
    if (fs.existsSync(provDir)) {   // provenance product is authoritative: sale_primary (paid phases) + mint_free (free claims); mint_treasury/stock moves are not sales
      const first = {}; for (const f of fs.readdirSync(provDir).filter(x => /\.json$/.test(x)).sort()) for (const t of rj(path.join(provDir, f))) { const e = (t.events || []).find(x => x.type === 'sale_primary' || x.type === 'mint_free'); if (!e) continue; const price = e.cost ? { amount: e.cost.amount, denom: e.cost.denom } : { amount: '0', denom: null }; const u = usdAt(price, e.ts); first[t.token_id] = { token_id: t.token_id, buyer: e.to, ts: e.ts, height: e.height, txhash: e.txhash, phase: e.phase_id || null, price, usd: u.usd, usd_reason: u.usd_reason, luna_usd: u.luna_usd ?? null }; }
      const paid = Object.values(first).filter(x => Number(x.price.amount) > 0);
      wj(path.join(base, 'primary-sales.json'), { collection: c, source: 'nfts/' + c + '/provenance (authoritative)', tokens: Object.keys(first).length, paid: paid.length, free_or_admin: Object.keys(first).length - paid.length, total_luna: paid.reduce((s, x) => s + Number(x.price.amount) / 1e6, 0), total_usd: paid.reduce((s, x) => s + (x.usd || 0), 0), usd_unpriced: paid.filter(x => x.usd == null).length, by_token: first, generatedAt: new Date().toISOString() });
    } else if (col.launchpad && col.launchpad.address) {
      const first = {}; all.filter(r => r.kind === KIND.MINT_PURCHASE).sort((a, b) => a.height - b.height).forEach(r => { if (!first[r.token_id]) first[r.token_id] = { token_id: r.token_id, buyer: r.to, ts: r.ts, height: r.height, txhash: r.txhash, price: r.price, usd: r.usd ?? null, usd_reason: r.usd_reason, luna_usd: r.luna_usd ?? null }; });
      const paid = Object.values(first).filter(x => x.price && Number(x.price.amount) > 0);
      wj(path.join(base, 'primary-sales.json'), { collection: c, launchpad: col.launchpad.address, tokens: Object.keys(first).length, paid: paid.length, free_or_admin: Object.keys(first).length - paid.length, total_usd: paid.reduce((s, x) => s + (x.usd || 0), 0), usd_unpriced: paid.filter(x => x.usd == null).length, by_token: first, generatedAt: new Date().toISOString() });
    }
    // lock lineage graph
    if (col.kind === 'escrow') {
      const edges = []; all.forEach(r => { if (r.lineage && r.lineage.from_ids) for (const f of r.lineage.from_ids) for (const t of (r.lineage.to_ids || [])) if (f !== t) edges.push({ from: f, to: t, kind: r.kind, ts: r.ts, txhash: r.txhash }); if (r.kind === KIND.LOCK_MERGE) for (const b of (r.lineage.burned || [])) edges.push({ from: b, to: r.token_id, kind: 'lock_merge', ts: r.ts, txhash: r.txhash }); });
      wj(path.join(base, 'lineage.json'), { collection: c, edges, generatedAt: new Date().toISOString(), note: 'follow edges from an id to find its descendants; migrate/split/merge create or fold ids' });
    }
    // coverage + honest gaps: sorted ranges; anything between ranges (or before genesis / after the last range) is a gap
    let prior = []; try { const pi = rj(path.join(base, 'index.json')); prior = (pi.coverage || []).filter(cv => !cv.partial && !(cv.source in o.coverage) && !/^(fcd|tla-flows\/raw|nfts\/raw|imported):/.test('') && !fs.existsSync(path.join(ROOT, cv.source.split(':')[0]))).map(cv => Object.assign({}, cv, { imported: cv.imported || 'archive stays in tla-core; coverage carried from the imported index' })); } catch { }
    const ranges = [...prior, ...Object.entries(o.coverage).map(([src, v]) => ({ source: src, from: v.from, to: v.to, parts: v.parts, partial: v.partial }))].sort((a, b) => a.from - b.from);
    const gaps = []; let cur = null; for (const r of ranges.filter(r => !r.partial)) { if (cur && r.from > cur + 1) gaps.push({ from_height: cur + 1, to_height: r.from - 1, reason: 'no archived part covers this span' }); cur = Math.max(cur || 0, r.to); }
    const index = { product: c + '/ledger', schema: 'nft-flows-1.0', classifier: 'NFT FLOWS CLASSIFIER v1', collection: c, label: col.label, total: all.length, by_kind: byKind, months: Object.keys(o.byMonth).sort(), coverage: ranges, known_gaps: gaps, forward_stream: `org-nft-flows-${c} (Render) → ${c}/raw/forward + this ledger`, added_this_run: o.n, skipped_duplicates: o.dup, generatedAt: new Date().toISOString() };
    wj(path.join(base, 'index.json'), index);
    wj(path.join(base, 'heartbeat.json'), { module: 'nft-flows', product: c + '/ledger', kind: 'derive', ran_at: new Date().toISOString(), parts_read: partsRead, txs_read: txsRead, records_total: all.length, added: o.n, ms: Date.now() - t0 });
    console.log(`${c}: ${all.length} records (${o.n} new, ${o.dup} dup${o.dropped_dup ? ', ' + o.dropped_dup + ' imported duplicates dropped' : ''}) · kinds ${JSON.stringify(byKind)} · coverage ${ranges.map(r => r.from + '–' + r.to).join(', ') || 'none'} · gaps ${gaps.length}`);
  }
  console.log(`derive done: ${partsRead} parts, ${txsRead} txs, ${Date.now() - t0} ms${DRY ? ' (DRY — nothing written)' : ''}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
