#!/usr/bin/env node
// validate-collection.js — the self-serve onboarding gate.
// Usage: node .github/scripts/validate-collection.js <slug> [--template]
// Green output = the collection's files agree with each other and the contract
// in FORMATS.md. This is the bar for enabling a collection — nobody eyeballs.
'use strict';
const fs = require('fs'), path = require('path');
const slug = process.argv[2];
if (!slug) { console.error('usage: validate-collection.js <slug>'); process.exit(1); }
const T = slug === '_template';
const F = (p) => path.join(slug, p);
let fails = 0;
const ck = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++; };
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const cfgPath = F('collection.json');
ck('collection.json exists', fs.existsSync(cfgPath));
if (!fs.existsSync(cfgPath)) process.exit(1);
const cfg = load(cfgPath);

for (const k of ['slug', 'name', 'nft_contract', 'chain', 'supply', 'traits', 'marketplaces', 'features']) ck(`config: ${k} present`, cfg[k] !== undefined, k);
if (!T) {
  ck('config: slug matches folder', cfg.slug === slug);
  ck('config: contract looks like terra1…', /^terra1[a-z0-9]{38,60}$/.test(cfg.nft_contract || ''));
  ck('config: supply is a positive integer', Number.isInteger(cfg.supply) && cfg.supply > 0);
  ck('config: no _-prefixed guide keys left', !JSON.stringify(cfg).includes('"_'));
}
for (const m of cfg.marketplaces || []) {
  ck(`marketplace ${m.key}: urls carry {contract} placeholder`, !m.token_url || m.token_url.includes('{contract}'));
}
if (cfg.backing) for (const k of ['treasury_address', 'token', 'per_nft_rule']) ck(`backing: ${k}`, cfg.backing[k] != null);

// the three data files (template uses .sample names)
const metaP = T ? F('metadata/metadata.sample.json') : F('metadata/metadata.json');
const refP  = T ? F('metadata/traits-reference.sample.json') : F('metadata/traits-reference.json');
const rarP  = T ? F('rarity/rarity.sample.json') : F('rarity/rarity.json');
const have = { meta: fs.existsSync(metaP), ref: fs.existsSync(refP), rar: fs.existsSync(rarP) };
ck('traits-reference exists', have.ref);
ck('metadata exists', have.meta, have.meta ? '' : 'run/produce it, then re-validate');
ck('rarity exists', have.rar, have.rar ? '' : 'pick a method (statistical is computable from the reference)');
const SUPPLY = T ? 3 : cfg.supply;

if (have.ref) {
  const ref = load(refP);
  for (const [t, v] of Object.entries(ref.traits || {})) {
    const s = Object.values(v.values || {}).reduce((a, b) => a + b, 0);
    ck(`reference: ${t} counts sum to supply`, s === SUPPLY, `${s} vs ${SUPPLY}`);
  }
}
if (have.meta) {
  const meta = load(metaP);
  ck('metadata: exactly supply entries', meta.length === SUPPLY, `${meta.length}`);
  ck('metadata: ids unique', new Set(meta.map(m => m.id)).size === meta.length);
  if (have.ref) {
    const ref = load(refP);
    const counts = {};
    let unknown = 0;
    for (const m of meta) for (const a of m.attributes || []) {
      if (!ref.traits[a.trait_type] || ref.traits[a.trait_type].values[a.value] === undefined) unknown++;
      counts[a.trait_type] = counts[a.trait_type] || {};
      counts[a.trait_type][a.value] = (counts[a.trait_type][a.value] || 0) + 1;
    }
    ck('metadata: every trait/value exists in the reference', unknown === 0, unknown ? `${unknown} unknown` : '');
    let mismatch = 0;
    for (const [t, v] of Object.entries(ref.traits)) for (const [val, c] of Object.entries(v.values)) {
      if ((counts[t] || {})[val] !== c) mismatch++;
    }
    ck('metadata ↔ reference: counts reconcile EXACTLY', mismatch === 0, mismatch ? `${mismatch} values differ` : '');
  }
}
if (have.rar) {
  const rar = load(rarP);
  ck('rarity: method declared', !!rar.method);
  ck('rarity: exactly supply records', (rar.records || []).length === SUPPLY, `${(rar.records || []).length}`);
  const ranks = (rar.records || []).map(r => r.rank);
  ck('rarity: ranks span 1..supply', Math.min(...ranks) === 1 && Math.max(...ranks) === SUPPLY);
}
console.log(fails === 0 ? '\nVALIDATION PASS — onboarding-ready' : `\nVALIDATION FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
