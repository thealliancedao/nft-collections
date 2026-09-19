# NFT-Collections

NFT data and reference for every collection tracked by the platform. **One folder per collection; the folder is the
registry entry AND the data home.** Since the aDAO migration (2026-09-13) EVERYTHING aDAO lives here too — snapshots,
flows, transfers, provenance, claims, the two FCD archives and the ledger; `tla-core` is TLA data only and has no `nfts/`.

## Collections
- `adao/` — Alliance DAO (10,000, treasury-backed). Ledger + snapshots/ (org-nft-inventory) + flows/ (org-nft-adao-daily)
  + transfers/ (org-tla-flows NFT aux leg) + provenance/ + claims/ + archive/fcd/{collection,minter}. Readers: every
  site page, the app, member-data/dao-dashboard, system-health, help-agent (`read_product` accepts `nfts/adao/…` and
  `nft-collections/<slug>/…`).
- `pixel-lions/` — pixeLions (5,000, own DAODAO DAO, BBL + Atrium + Boost). Ledger + by-token shards + snapshots/ (org-nft-inventory-liondao, since 2026-09-18) + claims/. Ally: Lion DAO (tenants.json `liondao`).
- `tla-locks/` — TLA lock NFTs (vAMP escrow; open-ended supply; Atrium).

## Per-collection layout
```
<slug>/
├── ledger/by-token/           nft-flows 1.4.0: every live ledger row per token, 100 tokens per shard + index.json — the read
│                              shape for "open an NFT → its journey" (explorer sheet, app, portfolio NFT leg)
├── collection.json            config: contract, supply, traits, images, rarity  + capture block (custodians, launchpad,
│                              minter, distributor, vetoer, royalty per venue, venues, gate, handle source, archives)
├── metadata/  rarity/  lore/  reference data (FORMATS.md)
├── archive/fcd/<role>/        one-time FCD harvest parts (genesis → 2025-01-07)
├── raw/<from>-<to>/           one-time walk parts (archive node for the pruned span) + raw/forward/YYYY-MM-DD.json.gz (live)
├── ledger/YYYY/MM.json        the on-chain event ledger (mints, sales, listings, stakes, locks …) + index.json,
│                              primary-sales.json (USD at the day), lineage.json (locks), cursor.json (live)
└── nft-flows/heartbeat.json   the collection's Render cron
(aDAO only, in addition:) snapshots/ flows/ transfers/ provenance/ claims/ — the inventory/state-diff/aux/provenance products
```
Shared, at the root: `venues.json` (BBL · Atrium · Boost · 2023 venues), `_shared/` (fetched at run time, not committed).

## How a collection is powered up (RUNBOOK-add-a-collection.md)
1. Folder + `collection.json` with a `capture` block (copy `pixel-lions/`). Validator green.
2. One-time history (Actions, this repo): `fcd-harvest` per role → `nft-flows-walk` (archive node, 13,737,811→21,481,530,
   self-chaining) → `nft-flows-derive` → `nft-flows-forward` once (public RPC, to today).
3. Live: a Render service `org-nft-flows-<slug>` from `platform-crons/nfts/nft-flows` with `COLLECTION=<slug>`.
   Its own cursor, its own heartbeat, writes only in its own folder. Stop or delete it without touching the others.

## Who runs what (2026-09-18)
- The engines live in platform-crons (`nfts/nft-flows/`, `nfts/nft-inventory/`) and belong to no collection.
- Allies and their collections: `tla-core/docs/curated/tenants.json`. One Render inventory service per ally
  (`org-nft-inventory` = aDAO, `org-nft-inventory-liondao` = Pixel Lions + Burning Lions when onboarded) runs each collection
  as its own process into its own folder here. Removing an ally never touches another folder.
- `collection.json` is the ONLY per-collection input: contract, `governance` (DAO core, DAODAO module), `capture.custodians`
  by ROLE (Enterprise legacy…), `capture.launchpad.addresses` + `distribution_wallets` (+ labels), `marketplaces` (every venue
  the collection's tokens actually sit in — the chain is the oracle: PL was "bbl only" until the first inventory run found
  Atrium 2 / Boost 6), `backing` (null = no backing / tiers vocabulary), `custody` / `tiers` (aDAO's treasury, council,
  operator, Phoenix ids), `traits`, `rarity.file`, `metadata_file`.

## Rules
- Actions = one-time (harvest, walk, derive, fill, `import-from-tla-core`). Render = scheduled. Both write the same paths.
- Forward capture = PUBLIC endpoints only; the archive node is for the one-time history the public node cannot see.
- Tokens: a Render service writing here needs a fine-grained PAT with contents:write on nft-collections (a tla-core-only
  token 403s: "Resource not accessible by personal access token").
- One classifier: `.github/scripts/nft-flows/classify.js` here == `platform-crons/nfts/nft-flows/lib/classify.js` (byte-identical, diff-gated).
- Nothing in one collection's folder is read or written by another collection's job.
