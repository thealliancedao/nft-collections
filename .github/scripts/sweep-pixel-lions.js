// =============================================================================
// sweep-pixel-lions.js — one-off: mirror the pixeLions collection from warlock
// =============================================================================
// Warlock (BBL's API) serves everything the platform needs per token: rank,
// top_percent, rarity score, and the full trait list. This sweep paginates all
// of it and writes the two org-format files the collection registry expects:
//
//   pixel-lions/metadata/metadata.json   [{id, name, attributes:[{trait_type,value}]}]
//   pixel-lions/rarity/rarity.json       {method, records:[{token_id, rank, top_percent, rarity_score}]}
//
// REFUSAL GATES (a wrong mirror is worse than no mirror):
//   G1 exactly 5,000 unique token ids
//   G2 every trait value's count reconciles EXACTLY to metadata/traits-reference.json
//      (transcribed from the marketplace UI and already API-validated on page 1)
//   G3 the 74 known rank anchors match (owner-transcribed tops 1-36 and bottoms
//      4965-5000 from the ranked UI, plus tokens #1→4760 and #2→3348 confirmed
//      in captured API responses). Bottom anchors tolerate ±1 for tie ordering.
//   G4 ranks are a permutation-with-ties covering 1..5000 (min 1, max 5000)
//
// Runs in GitHub Actions (network available there); commits with the repo's
// own default token — no new credentials.
// =============================================================================
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONTRACT = 'terra17z7fpaa8kah698xn5tarrcucvualdy4wsztkfc404g3garucpu6qmxp50g';
const BASE = `https://warlock.backbonelabs.io/api/v1/dapps/necropolis/nfts?nftContract=${CONTRACT}`;
const PER_PAGE = 40;
const SUPPLY = 5000;

function fetchJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'tla-collection-sweep/1.0', 'Accept': 'application/json' }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (attempt < 5) return setTimeout(() => fetchJson(url, attempt + 1).then(resolve, reject), 800 * attempt);
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', (e) => {
      if (attempt < 5) return setTimeout(() => fetchJson(url, attempt + 1).then(resolve, reject), 800 * attempt);
      reject(e);
    }).on('timeout', function () { this.destroy(new Error('timeout ' + url)); });
  });
}

// Owner-transcribed anchors (ranked marketplace UI, 2026-08-23) + two API-confirmed.
const ANCHORS_TOP = { 2082: 1, 909: 1, 2446: 1, 710: 1, 2466: 1, 2311: 6, 3661: 7, 3788: 8, 4827: 9, 4905: 10, 1763: 11, 4011: 12, 3387: 13, 1783: 14, 1594: 15, 5: 16, 3808: 17, 3743: 18, 4663: 19, 4417: 20, 3248: 21, 3202: 22, 2293: 23, 2188: 24, 1859: 25, 732: 26, 4342: 27, 4746: 28, 667: 29, 883: 30, 4522: 31, 1880: 32, 2055: 33, 3839: 34, 2734: 35, 1743: 36 };
const ANCHORS_BOTTOM = { 3822: 5000, 4222: 4999, 4973: 4998, 1260: 4997, 145: 4996, 3589: 4995, 4266: 4994, 3367: 4993, 1296: 4992, 2854: 4991, 2366: 4989, 156: 4989, 2017: 4988, 3798: 4987, 2397: 4986, 122: 4985, 652: 4984, 927: 4983, 750: 4982, 2758: 4981, 1724: 4980, 3893: 4978, 2664: 4978, 1011: 4977, 4754: 4976, 573: 4975, 4246: 4974, 808: 4973, 4039: 4972, 3401: 4971, 1253: 4970, 1631: 4968, 3491: 4968, 3550: 4967, 429: 4966, 2571: 4965 };
const ANCHORS_API = { 1: 4760, 2: 3348 };

async function main() {
  const outDir = process.env.OUT_DIR || 'pixel-lions';
  const ref = JSON.parse(fs.readFileSync(path.join(outDir, 'metadata/traits-reference.json'), 'utf8'));

  const byId = new Map();
  for (let page = 1; ; page++) {
    const d = await fetchJson(`${BASE}&page=${page}&perPage=${PER_PAGE}`);
    const items = d.nfts || [];
    for (const n of items) {
      byId.set(String(n.nft_token_id), {
        id: Number(n.nft_token_id),
        name: n.nft_name || `pixeLion #${n.nft_token_id}`,
        rank: n.rank, top_percent: n.top_percent, rarity: n.rarity,
        attributes: (n.traits || []).map(t => ({ trait_type: t.trait_type, value: t.value })),
      });
    }
    const total = d.pagination && (d.pagination.totalPages || d.pagination.total_pages);
    console.log(`  page ${page}${total ? '/' + total : ''} — ${byId.size} tokens`);
    if (!items.length || (total && page >= total)) break;
    if (page > 200) throw new Error('page overrun — pagination shape changed?');
    await new Promise(r => setTimeout(r, 150));   // be polite to warlock
  }

  // G1
  if (byId.size !== SUPPLY) throw new Error(`G1: swept ${byId.size} unique tokens, expected ${SUPPLY} — refusing`);
  // G2 — trait counts reconcile EXACTLY to the reference
  const counts = {};
  for (const t of byId.values()) for (const a of t.attributes) {
    counts[a.trait_type] = counts[a.trait_type] || {};
    counts[a.trait_type][a.value] = (counts[a.trait_type][a.value] || 0) + 1;
  }
  for (const [trait, vals] of Object.entries(ref.traits)) {
    for (const [v, c] of Object.entries(vals.values)) {
      if ((counts[trait] || {})[v] !== c) throw new Error(`G2: ${trait}/${v} swept ${(counts[trait] || {})[v]} vs reference ${c} — refusing`);
    }
  }
  // G3 — rank anchors
  const bad = [];
  for (const [id, r] of Object.entries({ ...ANCHORS_TOP, ...ANCHORS_API })) {
    const got = byId.get(String(id));
    if (!got || got.rank !== r) bad.push(`#${id}: swept ${got && got.rank} vs anchor ${r}`);
  }
  for (const [id, r] of Object.entries(ANCHORS_BOTTOM)) {
    const got = byId.get(String(id));
    if (!got || Math.abs(got.rank - r) > 1) bad.push(`#${id}: swept ${got && got.rank} vs anchor ${r} (±1)`);
  }
  if (bad.length) throw new Error(`G3: ${bad.length} anchor mismatches — refusing\n  ` + bad.join('\n  '));
  // G4 — rank range
  const ranks = [...byId.values()].map(t => t.rank);
  if (Math.min(...ranks) !== 1 || Math.max(...ranks) !== SUPPLY) throw new Error(`G4: rank range ${Math.min(...ranks)}..${Math.max(...ranks)} — refusing`);

  const tokens = [...byId.values()].sort((a, b) => a.id - b.id);
  const metadata = tokens.map(t => ({ id: t.id, name: t.name, attributes: t.attributes }));
  const rarity = {
    schemaVersion: 1, method: 'bbl-statistical-mirror',
    source: 'warlock.backbonelabs.io necropolis API', sweptAt: new Date().toISOString(),
    note: 'BBL marketplace ranks mirrored 1:1; gated on 74 known anchors + exact trait-count reconciliation vs traits-reference.json',
    records: tokens.map(t => ({ token_id: String(t.id), rank: t.rank, top_percent: t.top_percent, rarity_score: t.rarity })),
  };
  fs.mkdirSync(path.join(outDir, 'metadata'), { recursive: true });   // git can't track empty dirs — create on write
  fs.mkdirSync(path.join(outDir, 'rarity'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'metadata/metadata.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(outDir, 'rarity/rarity.json'), JSON.stringify(rarity));
  console.log(`✓ all gates green — metadata.json (${metadata.length} tokens) + rarity.json written`);
}

main().catch(e => { console.error('sweep failed:', e.message); process.exit(1); });
