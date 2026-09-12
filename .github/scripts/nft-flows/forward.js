'use strict';
// forward.js — nft-flows forward 1.0 (SPEC-nft-flows.md). The ledger's forward capture AND the add-a-collection
// mechanism: for EVERY collection in docs/curated/nft-collections.json, find the last height any archive on disk
// covers, walk from there to the chain head on RPC_URL (public node, retention span), write raw parts (walk.js,
// write-once), then derive. A collection added to the registry today is walked from its archives' end tomorrow —
// no per-collection code, no touching the others.
//   env: RPC_URL (required, public RPC) · GITHUB_TOKEN · ROOT · MIN_BLOCKS (skip a collection if fewer new blocks; default 300)
//        HEAD_LAG (blocks kept back from the tip so the node's index is settled; default 20) · COLLECTIONS (comma list, blank = all)
//   Chunks: CHUNK_BLOCKS default 400000 (retention spans are ≤ ~2.1M blocks; a full first-time forward fill is a few chunks).
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');
const { spawnSync } = require('child_process');
const ROOT = process.env.ROOT || process.cwd();
const RPC = String(process.env.RPC_URL || '').replace(/\/+$/, '');
const MIN = Number(process.env.MIN_BLOCKS || 300), LAG = Number(process.env.HEAD_LAG || 20), CHUNK = Number(process.env.CHUNK_BLOCKS || 400000);
const ONLY = (process.env.COLLECTIONS || '').split(',').map(s => s.trim()).filter(x => x && x !== 'all');   // 'all' = no filter (the workflow dropdown)
if (!RPC) { console.error('FATAL: RPC_URL missing'); process.exit(1); }
const { loadRegistry, layout } = require('./registry.js');
const reg = loadRegistry(ROOT);

function get(url) { return new Promise((res, rej) => { (url.startsWith('http:') ? http : https).get(url, { headers: { Accept: 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON from ' + url)); } }); }).on('error', rej); }); }
const rangeDirs = (dir) => { try { return fs.readdirSync(dir).filter(d => /^\d+-\d+$/.test(d)).map(d => { const [a, b] = d.split('-').map(Number); let to = b; try { const r = JSON.parse(fs.readFileSync(path.join(dir, d, 'report.json'), 'utf8')); if (Number.isFinite(r.walked_to)) to = Math.min(b, r.walked_to); } catch { } return [a, to]; }).filter(r => r[1] >= r[0]); } catch { return []; } };   // a budget-stopped walk covers only to report.walked_to
function lastWalked(key, col) {
  // every archive that fully covers this collection: its own walk parts, and tla-flows/raw when the registry says so
  const ranges = [...rangeDirs(layout(ROOT, key).raw)];
  // FCD harvests end at the freeze; they only matter when nothing later exists
  let hi = ranges.length ? Math.max(...ranges.map(r => r[1])) : 0;
  if (!hi) for (const label of (col.archives && col.archives.fcd) || []) { const p = path.join(layout(ROOT, key).fcd, label); for (const f of (fs.existsSync(p) ? fs.readdirSync(p) : [])) { try { const m = f.match(/^part-\d+\.json(\.gz)?$/); if (!m) continue; const d = f.endsWith('.gz') ? JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(p, f)))) : JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')); if (d.height_range) hi = Math.max(hi, d.height_range[1]); } catch { } } }
  return hi || (col.genesis_height ? col.genesis_height - 1 : 0);
}
(async () => {
  const st = await get(RPC + '/status'); const head = Number(st.result.sync_info.latest_block_height) - LAG;
  console.log(`nft-flows forward · head ${head} (lag ${LAG}) · rpc ${RPC.replace(/^https?:\/\//, '').slice(0, 30)}…`);
  const summary = [];
  for (const [key, col] of Object.entries(reg.collections)) {
    if (ONLY.length && !ONLY.includes(key)) continue;
    const last = lastWalked(key, col); const from = last + 1;
    if (!last) { console.log(`  ${key}: no archive on disk — skipping (run the FCD harvest / an initial walk first, or set genesis_height)`); summary.push({ key, skipped: 'no archive' }); continue; }
    if (head - from + 1 < MIN) { console.log(`  ${key}: last walked ${last}, head ${head} — ${head - last} new blocks < ${MIN}, skipping`); summary.push({ key, last, head, skipped: 'too few blocks' }); continue; }
    let cur = from, ok = true;
    while (cur <= head) {
      const to = Math.min(cur + CHUNK - 1, head);
      console.log(`  ${key}: walking ${cur} → ${to}`);
      const r = spawnSync('node', [path.join(__dirname, 'walk.js')], { stdio: 'inherit', env: Object.assign({}, process.env, { COLLECTION: key, WALK_FROM: String(cur), WALK_TO: String(to), FINAL_HEIGHT: '', RPC_URL: RPC, ARCHIVE_RPC: '', ROOT }) });
      if (r.status !== 0) { console.error(`  ${key}: walk ${cur}-${to} FAILED (exit ${r.status}) — stopping this collection; the next run resumes from ${cur}`); ok = false; break; }
      cur = to + 1;
    }
    summary.push({ key, from, to: ok ? head : cur - 1, ok });
  }
  console.log('forward summary:', JSON.stringify(summary));
  fs.mkdirSync(path.join(ROOT, '_shared'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '_shared', 'forward-summary.json'), JSON.stringify({ ran_at: new Date().toISOString(), head, summary }, null, 1) + '\n');
  if (summary.some(s => s.ok === false)) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
