# NFT-Collections

NFT data and reference for every collection tracked by the platform. **One folder per collection; the folder is the
registry entry AND the data home.** aDAO's original products stay in `tla-core/nfts/adao/` (the reference build);
every collection's on-chain ledger — aDAO's included — lives here.

## Collections
- `adao/` — Alliance DAO (10,000, treasury-backed). Ledger here; snapshots/inventory/analytics still in tla-core.
- `pixel-lions/` — pixeLions (5,000, own DAODAO DAO, BBL + Atrium + Boost).
- `tla-locks/` — TLA lock NFTs (vAMP escrow; open-ended supply; Atrium).

## Per-collection layout
```
<slug>/
├── collection.json            config: contract, supply, traits, images, rarity  + capture block (custodians, launchpad,
│                              minter, distributor, vetoer, royalty per venue, venues, gate, handle source, archives)
├── metadata/  rarity/  lore/  reference data (FORMATS.md)
├── archive/fcd/<role>/        one-time FCD harvest parts (genesis → 2025-01-07)
├── raw/<from>-<to>/           one-time walk parts (archive node for the pruned span) + raw/forward/YYYY-MM-DD.json.gz (live)
├── ledger/YYYY/MM.json        the on-chain event ledger (mints, sales, listings, stakes, locks …) + index.json,
│                              primary-sales.json (USD at the day), lineage.json (locks), cursor.json (live)
└── nft-flows/heartbeat.json   the collection's Render cron
```
Shared, at the root: `venues.json` (BBL · Atrium · Boost · 2023 venues), `_shared/` (fetched at run time, not committed).

## How a collection is powered up (RUNBOOK-add-a-collection.md)
1. Folder + `collection.json` with a `capture` block (copy `pixel-lions/`). Validator green.
2. One-time history (Actions, this repo): `fcd-harvest` per role → `nft-flows-walk` (archive node, 13,737,811→21,481,530,
   self-chaining) → `nft-flows-derive` → `nft-flows-forward` once (public RPC, to today).
3. Live: a Render service `org-nft-flows-<slug>` from `platform-crons/nfts/nft-flows` with `COLLECTION=<slug>`.
   Its own cursor, its own heartbeat, writes only in its own folder. Stop or delete it without touching the others.

## Rules
- Actions = one-time (harvest, walk, derive, fill). Render = scheduled. Both write the same paths.
- One classifier: `.github/scripts/nft-flows/classify.js` here == `platform-crons/nfts/nft-flows/lib/classify.js` (byte-identical, diff-gated).
- Nothing in one collection's folder is read or written by another collection's job.
