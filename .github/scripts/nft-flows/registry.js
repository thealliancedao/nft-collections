'use strict';
// registry.js — builds the classifier's registry from THIS repo's layout: venues.json (shared) + every <slug>/collection.json
// with a `capture` block. One folder per collection; the folder IS the registry entry and the data home.
//   layout(slug): ledger  <slug>/ledger/      raw  <slug>/raw/<from>-<to>/      fcd  <slug>/archive/fcd/<label>/
const fs = require('fs'), path = require('path');
function loadRegistry(root) {
  const venues = JSON.parse(fs.readFileSync(path.join(root, 'venues.json'), 'utf8')).venues;
  const collections = {};
  for (const d of fs.readdirSync(root)) {
    const cj = path.join(root, d, 'collection.json'); if (d.startsWith('.') || d.startsWith('_') || !fs.existsSync(cj)) continue;
    const c = JSON.parse(fs.readFileSync(cj, 'utf8')); if (!c.capture) continue;   // metadata-only folders are not captured yet
    collections[c.slug || d] = Object.assign({ label: c.name, collection: c.nft_contract, supply: c.supply, kind: c.kind }, c.capture);
  }
  return { venues, collections };
}
const layout = (root, slug) => ({ ledger: path.join(root, slug, 'ledger'), raw: path.join(root, slug, 'raw'), fcd: path.join(root, slug, 'archive', 'fcd'), rawRel: `${slug}/raw` });
module.exports = { loadRegistry, layout };
