# RUNBOOK — add an NFT collection to thealliancedao.com

Everything learned on aDAO, Pixel Lions and TLA locks is encoded in the registry + one classifier, so a new
collection is a registry entry and three workflow runs. Nothing about the existing collections is touched.

## 1. Collect from the collection's members (the only human step)
| need | why | where it shows up |
|---|---|---|
| collection contract (cw721) | the watch set; everything keys on it | `collections.<key>.collection` |
| DAODAO voting module (if they stake on DAO DAO) | stake / unstake / claim custody | `custodians` role `daodao_voting` (+ unbonding seconds) |
| any legacy staking contract (Enterprise etc.) | "still staked in …" custody | `custodians` role `enterprise_staking` |
| launchpad holder (if minted via BBL launchpad) | outbound transfer = primary sale, price ÷ tokens out | `launchpad.address` |
| minter wallet / distribution wallets | label admin moves, never sales | `minter`, `distribution_wallets` |
| rewards distributor (DAO DAO) | rewards leg on Today | `distributor` |
| vetoer / treasury / royalty recipients per venue | attribution of the 5% leg; veto rows | `vetoer`, `royalty_recipients` |
| venues they trade on | shared venue table already covers BBL · Atrium · Boost; add only an unknown venue | `venues` |
| handle source + gate rule | who gets NAMED (policy, not chain data) | `handle_source`, `gate` |
| genesis height (optional) | forward start when no archive exists yet | `genesis_height` |
Unknown custodians are discoverable after the first walk: any contract that received `send_nft` shows up in the ledger
as `transfer` to a contract address — add it with a role and re-derive; records re-label, nothing is lost.

## 2. Register
Add the entry to `<slug>/collection.json` (`capture` block) in nft-collections (copy the `pixel` entry as the template). Add `archives.fcd`
labels you intend to harvest and `archives.raw: "nfts/raw/<key>"`. Add the FCD presets to `fcd-harvest.yml`
(or use the `custom` preset with the address).

## 3. History (three runs, in order)
1. `fcd-harvest` (nft-collections Actions) — collection=<slug>, role=collection, then voting / enterprise / escrow as
   they apply (genesis → 2025-01-07). Re-run the same inputs until it says COMPLETE.
2. `nft-flows-walk` — collection=<slug>, from `13737811`, final `21481530`, ARCHIVE_RPC (blank rpc_url). Chains itself.
3. `nft-flows-derive` — publishes `<slug>/ledger/` (month files, primary-sales with USD at the day, index with
   coverage + honest gaps).
Then the FCD-freeze day once: `nft-flows-walk` <slug> from `13728217` to `13737810` (to_height set, ~10k blocks), and
`nft-flows-forward` once (public RPC) so the ledger reaches today.

## 3b. ⚠ nft-flows-derive is BROKEN until repaired (2026-09-18)
`nft-flows-derive.yml` still curls the deleted `tla-core/nfts/adao/snapshots/luna-usd-daily.json` and `derive.js` prices
from it. Do NOT run it as is. Repair queued (CHANGES_PENDING B.4): derive.js prices from `tla-core/price-history/YYYY/MM.json`
like nft-flows 1.3.0. The forward cron's reprice pass will also fill USD on a ledger derived unpriced, month by month.

## 4. Forward
Render → new cron service `org-nft-flows-<slug>`: repo platform-crons, root `nfts/nft-flows`, start `node index.js`,
schedule `17 * * * *` (stagger minutes across collections), env `COLLECTION=<slug>`, `GITHUB_TOKEN` (nft-collections
write), `GITHUB_REPO=thealliancedao/nft-collections`. It bootstraps its cursor from the ledger's coverage edge and
keeps only its own folder current. Add it to the CRON-FLEET registry.

## 5. Inventory — per ALLY, from the same engine (2026-09-18)
Add the collection's slug to its ally's `collections` in `tla-core/docs/curated/tenants.json` (a new ally = a new block +
one Render cron `org-nft-inventory-<ally>`: repo platform-crons, root `nfts/nft-inventory`, start `node run-ally.js`, env
`ALLY=<ally>`, `GITHUB_REPO=thealliancedao/nft-collections`, the write token, no NFT_ROOT, a staggered `*/15` schedule). The
next run does a full scan and writes `<slug>/snapshots/` (nfts, summary, listings, floor/listing history, explorer bundle)
+ `<slug>/claims/`. Still queued: market-history seed-from-ledger (sales-enriched / listing-history for a new collection),
gate/roster, the manifest-driven explorer + app tab.

## What is NOT per-collection anymore
Venue verbs (BBL create_auction/place_bid/settle/cancel/deposit/make_offer · Atrium list_nft/cancel_listing/buy_nft/
make_offer_cw20/accept_offer · Boost launch-nft/setup/deposit_nft/cancel · 2023 trade + offers contracts), DAODAO
stake/unstake/claim, Enterprise custody, launchpad math, USD-at-the-day, lock lineage, legacy flattened-wasm parsing.
All in `nft-collections/.github/scripts/nft-flows/classify.js` (== platform-crons/nfts/nft-flows/lib/classify.js), gated by `gate-classify.mjs`.
