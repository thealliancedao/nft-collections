'use strict';
// derive.js — nft-flows derive 1.2.1 (SPEC-nft-flows.md). Runs inside the repo checkout (workflows nft-flows-derive.yml,
// nft-flows-forward.yml):
//   1.2.1 (2026-09-19, B.1): <slug>/raw/msg-bodies.json (resolve-msg-bodies) — message bodies fetched by hash for archived txs
//       whose part carries events only; attached as tx.messages when the part has none, so Boost list prices, Atrium list
//       denoms and DAODAO unstake token ids classify from the body exactly as an FCD part does. A 1.1.5 unstake row with
//       token_id null ("token ids live in the msg body") is the twin of the first per-token row the body yields (superseded).
//   1.2 (2026-09-19, CHANGES_PENDING B.1, classifier 1.1.6): LABELED REPAIRS instead of silent skips. A record the classifier
//       now produces for a key already on disk fills that row's NULL fields in place (price.denom, price, from, to, split;
//       USD re-read when the price became complete) and stamps `repaired_by` / `repaired_fields` — a value is never overwritten.
//       A record the classifier now keys differently (true msg_index from the event attribute, the token's own listing id)
//       is appended, and the 1.1.5 row it replaces — same tx, kind, collection, token, a key the classifier no longer
//       produces — is labeled `superseded_by` + `superseded_reason`, never deleted (never-shrink; readers skip superseded).
//       Env EXTERNAL_RAW_DIRS="<label>=<dir>[,…]" re-reads an archive that lives in another repo (aDAO's 2025 history is in
//       tla-core/tla-flows/raw; the workflow's `external_raw` input checks it out sparse) — rows merge by key, coverage
//       stays what collection.json capture.archives.external_coverage says (already counted).
//   1.1 (2026-09-19, CHANGES_PENDING B.4): USD at the day comes from THE org price oracle (tla-core/price-history/YYYY/MM.json)
//       through platform-crons/nfts/nft-flows/lib/oracle-usd.js — the SAME file the Render cron prices with, required from a
//       run-time checkout (env CRONS_DIR), never copied here; symbols from the token-catalog (lib/denom-symbol.js). The deleted
//       tla-core/nfts/adao/snapshots/luna-usd-daily.json is gone from this script and both workflows; a ledger derived with
//       no oracle on disk prices to null WITH the reason, and the forward cron's reprice pass fills it month by month.
//   inputs : <slug>/collection.json (capture block) + venues.json · <slug>/archive/fcd/<label>/part-*.json.gz (FCD era)
//            <slug>/raw/<from>-<to>/part-*.json.gz (archive / forward walks)
//            env TLA_CORE_DIR (a tla-core checkout with price-history/ + token-catalog/snapshots/) · env CRONS_DIR (platform-crons)
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

// ---------------------------------------------------------------- price at time (1.1: THE oracle, THE resolver — no copy)
const CRONS = process.env.CRONS_DIR || P('_crons'), CORE = process.env.TLA_CORE_DIR || P('_core');
let O = null, RESOLVE = null;
{
  const libp = path.join(CRONS, 'nfts/nft-flows/lib/oracle-usd.js');
  if (!fs.existsSync(libp)) { console.error(`FATAL: ${libp} missing — the workflow checks platform-crons out at _crons (env CRONS_DIR); derive prices with the cron's rule, not its own`); process.exit(1); }
  const OU = require(libp); const DS = require(path.join(CRONS, 'lib/denom-symbol.js'));
  try { RESOLVE = DS.buildResolver(rj(path.join(CORE, 'token-catalog/snapshots/current.json'))); console.log(`token-catalog: ${RESOLVE.size} denoms resolvable`); }
  catch (e) { console.warn(`token-catalog/snapshots/current.json unreadable at ${CORE} (${e.message}) — only uluna resolves; every other priced leg is labeled catalog_unavailable`); }
  O = OU.makeOracle({ fetchMonth: async (mk) => rj(path.join(CORE, 'price-history', mk + '.json')), resolve: () => RESOLVE });
}
// every oracle month on disk, loaded once (the Action runner's heap is not the Render heap; derive holds the whole ledger anyway)
async function loadOracle() {
  const root = path.join(CORE, 'price-history'); let n = 0;
  for (const y of (fs.existsSync(root) ? fs.readdirSync(root) : []).filter(d => /^\d{4}$/.test(d)).sort()) for (const m of fs.readdirSync(path.join(root, y)).filter(x => /^\d{2}\.json$/.test(x)).sort()) { if (await O.loadMonth(y + '/' + m.slice(0, 2))) n++; }
  if (!n) console.warn(`price-history has no months at ${root} — USD legs will be null (price_history_month_missing), the forward cron's reprice pass fills them`);
  else console.log(`price-history: ${n} months loaded, latest day ${O.latest()}`);
}
const usdAt = (price, ts) => O.usdAt(price, ts);   // same call sites as 1.0; the record now carries usd_basis / denom_symbol like the cron writes
const USD_KEYS = ['usd', 'usd_reason', 'usd_basis', 'unit_usd', 'luna_usd', 'denom_symbol', 'denom_decimals', 'denom_symbol_reason'];
const priceOf = (price, ts) => { const u = usdAt(price, ts); const o = {}; for (const k of USD_KEYS) o[k] = u[k] === undefined ? null : u[k]; return o; };   // primary-sales rows: every USD field present (null when absent) so a reader never guesses

// ---------------------------------------------------------------- archives on disk
function listParts(dir) { try { const all = fs.readdirSync(dir).filter(f => /^part-\d+\.json(\.gz)?$/.test(f)); const gz = new Set(all.filter(f => f.endsWith('.gz')).map(f => f.slice(0, -3))); return all.filter(f => f.endsWith('.gz') || !gz.has(f)).sort().map(f => path.join(dir, f)); } catch { return []; } }   // harvest writes .json; fcd-compact turns it into .json.gz — read either, never both
function* archives() {
  // 1.2: archives that live in another repo, named by label (rows keep the source label the 1.1 import wrote: `<label>:<range>`)
  for (const spec of String(process.env.EXTERNAL_RAW_DIRS || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const [label, dir] = spec.split('='); if (!label || !dir || !fs.existsSync(dir)) { console.warn(`EXTERNAL_RAW_DIRS: ${spec} — directory missing, skipped`); continue; }
    const owners = Object.keys(reg.collections).filter(c => (((reg.collections[c].archives || {}).external_coverage) || []).some(cv => String(cv.source || '').endsWith(label)));
    if (!owners.length) { console.warn(`EXTERNAL_RAW_DIRS: no collection declares external_coverage source ending in "${label}" — skipped`); continue; }
    for (const range of fs.readdirSync(dir).filter(d => /^\d+-\d+$/.test(d)).sort()) for (const f of listParts(path.join(dir, range))) yield { source: `${label}:${range}`, file: f, kind: 'raw', range, external: true, owner: null, only: owners };
  }
  // everything under the collection's own folder: <slug>/archive/fcd/<label>/part-* and <slug>/raw/<from>-<to>/part-*
  for (const col of Object.keys(reg.collections)) {
    const L = layout(ROOT, col);
    for (const label of (fs.existsSync(L.fcd) ? fs.readdirSync(L.fcd) : [])) for (const f of listParts(path.join(L.fcd, label))) yield { source: `${col}/archive/fcd:${label}`, file: f, kind: 'fcd', owner: col };
    for (const range of (fs.existsSync(L.raw) ? fs.readdirSync(L.raw) : []).filter(d => /^\d+-\d+$/.test(d))) for (const f of listParts(path.join(L.raw, range))) yield { source: `${col}/raw:${range}`, file: f, kind: 'raw', range, walked_for: col, owner: col };
  }
}
const BODIES = {};   // 1.2.1: per collection, <slug>/raw/msg-bodies.json → { txhash: { messages } } (loaded once, small)
function bodiesFor(col) { if (col in BODIES) return BODIES[col]; let b = null; try { const doc = rj(path.join(layout(ROOT, col).raw, 'msg-bodies.json')); b = doc && doc.bodies ? doc.bodies : null; if (b) console.log(`${col}: msg-bodies.json — ${Object.keys(b).length} resolved bodies attached to archived txs that carry events only`); } catch { } BODIES[col] = b; return b; }
function txsOf(a) {
  const d = rgz(a.file);
  if (a.kind === 'fcd') return { txs: d.txs || [], heights: d.height_range || null };
  const B = a.only ? Object.assign({}, ...a.only.map(c => bodiesFor(c) || {})) : bodiesFor(a.owner);   // an external part serves several collections: any of their bodies
  const txs = d.map(p => ({ txhash: p.x, height: p.h, timestamp: p.t, code: p.c, events: p.e, messages: p.m || (B && B[p.x] && B[p.x].messages) || undefined }));
  return { txs, heights: txs.length ? [Math.min(...txs.map(t => t.height)), Math.max(...txs.map(t => t.height))] : null };
}

// ---------------------------------------------------------------- 1.2: labeled merge (repair in place · supersede re-keyed)
const CLASSIFIER_REV = '1.1.6';
const REPAIR_FIELDS = ['from', 'to', 'split', 'listing_type', 'auction_type', 'cancelled_by', 'accepted_offer_id'];
function repairInPlace(o, e, r) {   // e: the row on disk, r: what the classifier now produces for the SAME key — fill nulls only
  const filled = [];
  for (const f of REPAIR_FIELDS) if ((e[f] === undefined || e[f] === null) && r[f] !== undefined && r[f] !== null) { e[f] = r[f]; filled.push(f); }
  if (r.price && (r.price.amount != null || r.price.denom != null)) {
    if (!e.price) { e.price = r.price; filled.push('price'); }
    else { if (e.price.amount == null && r.price.amount != null) { e.price.amount = r.price.amount; filled.push('price.amount'); } if (e.price.denom == null && r.price.denom != null) { e.price.denom = r.price.denom; filled.push('price.denom'); } }
  }
  if (filled.some(f => f.startsWith('price'))) { for (const k of USD_KEYS) delete e[k]; Object.assign(e, usdAt(e.price, e.ts)); filled.push('usd'); if (e.price_reason && r.price_reason == null) { delete e.price_reason; filled.push('price_reason'); } }   // the USD fields are re-read as a set (a stale usd_reason never survives a repaired price)
  if (!filled.length) return false;
  e.repaired_by = 'classify-' + CLASSIFIER_REV; e.repaired_fields = [...new Set([...(e.repaired_fields || []), ...filled])]; e.repaired_at = new Date().toISOString();
  o.repaired++; for (const f of filled) o.repaired_fields[f] = (o.repaired_fields[f] || 0) + 1;
  return true;
}
function whatDiffers(e, r) { const d = []; if (e.msg_index !== r.msg_index) d.push(`msg_index ${e.msg_index}→${r.msg_index}`); if ((e.token_id == null) !== (r.token_id == null)) d.push(`token_id ${e.token_id == null ? '-' : 'n'}→${r.token_id == null ? '-' : 'n'}`); for (const f of ['listing_id', 'auction_id', 'offer_id']) if ((e[f] || null) !== (r[f] || null)) d.push(`${f} ${e[f] || '-'}→${r[f] || '-'}`); return d.join(', ') || 'key'; }
function mergeTx(o, txhash, list) {
  const newKeys = new Set(list.map(recordKey));
  // rows on disk for this tx whose key the classifier no longer produces = candidates to be superseded (1.1.5 mis-keyed twins)
  const stale = (o.byTx.get(txhash) || []).filter(x => !x.superseded_by && !newKeys.has(recordKey(x)));
  for (const r of list) {
    const key = recordKey(r);
    if (o.seen.has(key)) { const e = o.byKey.get(key); if (e && !e.superseded_by && repairInPlace(o, e, r)) continue; o.dup++; continue; }
    let twinAt = stale.findIndex(x => x.kind === r.kind && x.collection === r.collection && String(x.token_id || '') === String(r.token_id || ''));
    if (twinAt < 0 && r.token_id != null) twinAt = stale.findIndex(x => x.kind === r.kind && x.collection === r.collection && x.token_id == null && (x.msg_index === r.msg_index || x.msg_index === 0));   // 1.2.1: the token-less 1.1.5 row (ids were in the body) is the twin of the first per-token row
    if (twinAt >= 0) { const t = stale.splice(twinAt, 1)[0]; const why = whatDiffers(t, r); t.superseded_by = key; t.superseded_reason = `classify-${CLASSIFIER_REV}: ${why}`; t.superseded_at = new Date().toISOString(); o.superseded++; o.superseded_why[why.replace(/\d+/g, 'n')] = (o.superseded_why[why.replace(/\d+/g, 'n')] || 0) + 1; }
    o.seen.add(key); o.byKey.set(key, r); (o.byTx.get(txhash) || o.byTx.set(txhash, []).get(txhash)).push(r);
    const mk = String(r.ts).slice(0, 7).replace('-', '/'); (o.byMonth[mk] ||= []).push(r); o.n++;
  }
}

// ---------------------------------------------------------------- run
(async () => {
  const t0 = Date.now(); await loadOracle();
  const out = {}; for (const c of cols) out[c] = { byMonth: {}, coverage: {}, seen: new Set(), byKey: new Map(), byTx: new Map(), n: 0, dup: 0, repaired: 0, superseded: 0, repaired_fields: {}, superseded_why: {} };
  // load existing month files (never-shrink)
  for (const c of cols) { const fr = layout(ROOT, c).ledger; if (!fs.existsSync(fr)) continue; for (const y of fs.readdirSync(fr).filter(d => /^\d{4}$/.test(d))) for (const m of fs.readdirSync(path.join(fr, y)).filter(f => /^\d{2}\.json$/.test(f))) { const raw = rj(path.join(fr, y, m)); if (!Array.isArray(raw)) { console.warn(`skip ${fr}/${y}/${m}: not a ledger month file`); continue; } const k = y + '/' + m.slice(0, 2); const recs = []; for (const r of raw) { r.collection = c; const key = recordKey(r); if (out[c].seen.has(key)) { out[c].dropped_dup = (out[c].dropped_dup || 0) + 1; continue; } out[c].seen.add(key); out[c].byKey.set(key, r); (out[c].byTx.get(r.txhash) || out[c].byTx.set(r.txhash, []).get(r.txhash)).push(r); recs.push(r); } out[c].byMonth[k] = recs; /* a ledger is per collection: the slug is the folder; imported months keyed by an older name are the same records */ } }
  let partsRead = 0, txsRead = 0;
  for (const a of archives()) {
    let { txs, heights } = txsOf(a); partsRead++; txsRead += txs.length;
    for (const tx of txs) {
      const recs = classifyNftTx(tx, reg, idx);
      // 1.2: every record this tx yields per collection, priced, THEN merged against what is on disk for the same tx
      const perCol = {};
      for (const r of recs) {
        const c = r.collection; if (!c || !out[c] || (a.only && !a.only.includes(c))) continue;   // venue-level records (deposit/withdraw/offers without a token) are attached below
        r.source = a.source; if (r.price) Object.assign(r, usdAt(r.price, r.ts)); (perCol[c] ||= []).push(r);
      }
      // venue-level (collection null) → every collection that lists on that venue keeps a copy under its own tree, so a wallet's BBL balance is visible from any collection page
      for (const r of recs.filter(x => !x.collection && x.venue)) for (const c of cols) { if (a.only && !a.only.includes(c)) continue; const cv = reg.collections[c].venues || []; if (!cv.includes(r.venue)) continue; const rr = Object.assign({}, r, { collection: c, source: a.source }); if (rr.price) Object.assign(rr, usdAt(rr.price, rr.ts)); (perCol[c] ||= []).push(rr); }
      for (const [c, list] of Object.entries(perCol)) mergeTx(out[c], tx.txhash, list);
    }
    if (a.kind === 'raw' && a.range) { const m = a.range.match(/^(\d+)-(\d+)$/); if (m) { let to = Number(m[2]); try { const r = rj(path.join(path.dirname(a.file), 'report.json')); if (Number.isFinite(r.walked_to)) to = Math.min(to, r.walked_to); } catch { } heights = to >= Number(m[1]) ? [Number(m[1]), to] : null; } }   // walked span per report.walked_to (a budget-stopped walk leaves a tail), never the matched-tx span
    if (heights && !a.external) for (const c of cols) { const cfg = reg.collections[c].archives || {}; const mine = a.owner === c; const partial = false; /* every archive lives in its owner's folder — no cross-collection partial coverage */ if (mine || partial) { const cv = (out[c].coverage[a.source] ||= { from: Infinity, to: 0, parts: 0, partial: partial ? 'venue txs only — this collection was not in the archive walk watch set' : undefined }); cv.from = Math.min(cv.from, heights[0]); cv.to = Math.max(cv.to, heights[1]); cv.parts++; } }
  }
  for (const c of cols) {
    const o = out[c]; const col = reg.collections[c]; const base = layout(ROOT, c).ledger;
    { const prior = (() => { try { return rj(path.join(base, 'index.json')).total; } catch { return 0; } })(); const now = Object.values(o.byMonth).flat().length; if (now < prior) { console.error(`FATAL ${c}: ledger would SHRINK ${prior} → ${now} — refusing (never-shrink)`); process.exit(1); } }   // 1.2: before any month is written
    for (const [mk, recs] of Object.entries(o.byMonth)) { recs.sort((a, b) => a.height - b.height || a.msg_index - b.msg_index); wj(path.join(base, mk + '.json'), recs); }
    const all = Object.values(o.byMonth).flat();
    const byKind = {}; all.forEach(r => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
    // primary sales: first launchpad exit per token (aDAO: the provenance product is authoritative; this file is derived only when a launchpad address is registered)
    const provDir = P(c, 'provenance', 'tokens');
    if (fs.existsSync(provDir)) {   // provenance product is authoritative: sale_primary (paid phases) + mint_free (free claims); mint_treasury/stock moves are not sales
      const first = {}; for (const f of fs.readdirSync(provDir).filter(x => /\.json$/.test(x)).sort()) for (const t of rj(path.join(provDir, f))) { const e = (t.events || []).find(x => x.type === 'sale_primary' || x.type === 'mint_free'); if (!e) continue; const price = e.cost ? { amount: e.cost.amount, denom: e.cost.denom } : { amount: '0', denom: null }; const u = priceOf(price, e.ts); first[t.token_id] = Object.assign({ token_id: t.token_id, buyer: e.to, ts: e.ts, height: e.height, txhash: e.txhash, phase: e.phase_id || null, price }, u); }
      const paid = Object.values(first).filter(x => Number(x.price.amount) > 0);
      wj(path.join(base, 'primary-sales.json'), { collection: c, source: 'nfts/' + c + '/provenance (authoritative)', tokens: Object.keys(first).length, paid: paid.length, free_or_admin: Object.keys(first).length - paid.length, total_luna: paid.reduce((s, x) => s + Number(x.price.amount) / 1e6, 0), total_usd: paid.reduce((s, x) => s + (x.usd || 0), 0), usd_unpriced: paid.filter(x => x.usd == null).length, by_token: first, generatedAt: new Date().toISOString() });
    } else if (col.launchpad && col.launchpad.address) {
      const first = {}; all.filter(r => r.kind === KIND.MINT_PURCHASE).sort((a, b) => a.height - b.height).forEach(r => { if (!first[r.token_id]) { const o = { token_id: r.token_id, buyer: r.to, ts: r.ts, height: r.height, txhash: r.txhash, price: r.price }; for (const k of USD_KEYS) o[k] = r[k] === undefined ? null : r[k]; first[r.token_id] = o; } });   // 1.1: the record's USD fields verbatim (basis, symbol), null when absent
      const paid = Object.values(first).filter(x => x.price && Number(x.price.amount) > 0);
      wj(path.join(base, 'primary-sales.json'), { collection: c, launchpad: col.launchpad.address, tokens: Object.keys(first).length, paid: paid.length, free_or_admin: Object.keys(first).length - paid.length, total_usd: paid.reduce((s, x) => s + (x.usd || 0), 0), usd_unpriced: paid.filter(x => x.usd == null).length, by_token: first, generatedAt: new Date().toISOString() });
    }
    // lock lineage graph
    if (col.kind === 'escrow') {
      const edges = []; all.forEach(r => { if (r.lineage && r.lineage.from_ids) for (const f of r.lineage.from_ids) for (const t of (r.lineage.to_ids || [])) if (f !== t) edges.push({ from: f, to: t, kind: r.kind, ts: r.ts, txhash: r.txhash }); if (r.kind === KIND.LOCK_MERGE) for (const b of (r.lineage.burned || [])) edges.push({ from: b, to: r.token_id, kind: 'lock_merge', ts: r.ts, txhash: r.txhash }); });
      wj(path.join(base, 'lineage.json'), { collection: c, edges, generatedAt: new Date().toISOString(), note: 'follow edges from an id to find its descendants; migrate/split/merge create or fold ids' });
    }
    // coverage + honest gaps: sorted ranges; anything between ranges (or before genesis / after the last range) is a gap
    const prior = (((col.archives || {}).external_coverage) || []).map(cv => ({ source: cv.source, from: cv.from, to: cv.to, parts: 0, imported: 'archive lives in tla-core; records imported (collection.json capture.archives.external_coverage)' }));
    const ranges = [...prior, ...Object.entries(o.coverage).map(([src, v]) => ({ source: src, from: v.from, to: v.to, parts: v.parts, partial: v.partial }))].sort((a, b) => a.from - b.from);
    const gaps = []; let cur = null; for (const r of ranges.filter(r => !r.partial)) { if (cur && r.from > cur + 1) gaps.push({ from_height: cur + 1, to_height: r.from - 1, reason: 'no archived part covers this span' }); cur = Math.max(cur || 0, r.to); }
    const index = { product: c + '/ledger', schema: 'nft-flows-1.0', classifier: 'NFT FLOWS CLASSIFIER v1 (' + CLASSIFIER_REV + ')', collection: c, label: col.label, total: all.length, by_kind: byKind, months: Object.keys(o.byMonth).sort(), coverage: ranges, known_gaps: gaps, forward_stream: `org-nft-flows-${c} (Render) → ${c}/raw/forward + this ledger`, added_this_run: o.n, skipped_duplicates: o.dup, repaired_this_run: o.repaired, repaired_fields: o.repaired_fields, superseded_this_run: o.superseded, superseded_why: o.superseded_why, superseded_total: all.filter(r => r.superseded_by).length, generatedAt: new Date().toISOString() };
    wj(path.join(base, 'index.json'), index);
    wj(path.join(base, 'heartbeat.json'), { module: 'nft-flows', product: c + '/ledger', kind: 'derive', ran_at: new Date().toISOString(), parts_read: partsRead, txs_read: txsRead, records_total: all.length, added: o.n, repaired: o.repaired, superseded: o.superseded, classifier: CLASSIFIER_REV, ms: Date.now() - t0 });
    console.log(`${c}: ${all.length} records (${o.n} new, ${o.dup} dup, ${o.repaired} repaired in place ${JSON.stringify(o.repaired_fields)}, ${o.superseded} superseded ${JSON.stringify(o.superseded_why)}${o.dropped_dup ? ', ' + o.dropped_dup + ' imported duplicates dropped' : ''}) · kinds ${JSON.stringify(byKind)} · coverage ${ranges.map(r => r.from + '–' + r.to).join(', ') || 'none'} · gaps ${gaps.length}`);
  }
  console.log(`derive done: ${partsRead} parts, ${txsRead} txs, ${Date.now() - t0} ms${DRY ? ' (DRY — nothing written)' : ''}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
