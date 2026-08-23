# Collection File Formats — the canonical contract

Every collection provides the SAME four files in its folder, regardless of
which marketplace it trades on (BBL, Boost, Atrium, several, or none) and
regardless of whether it is treasury-backed. Fill them, run the validator
(below), open a PR. Green validator = onboarding-ready; nobody has to
reverse-engineer anything.

```
<slug>/
├── collection.json                    the config (see _template/)
├── metadata/metadata.json             per-token traits
├── metadata/traits-reference.json     trait dictionary with counts (the truth table)
└── rarity/rarity.json                 per-token ranks
```

Two live examples: `adao/` (treasury-backed, break mechanism, 3 marketplaces)
and `pixel-lions/` (unbacked, own DAODAO DAO, single marketplace). Copy
whichever matches your shape; `_template/` is the annotated skeleton.

## metadata/metadata.json
One array, one object per token. `id` is the numeric token id; every trait is
a `{trait_type, value}` pair. Nothing marketplace-specific in here.

```json
[
  { "id": 1, "name": "MyCollection #1",
    "attributes": [
      { "trait_type": "Background", "value": "Blue" },
      { "trait_type": "Hat", "value": "None" }
    ] }
]
```

Rules: exactly `supply` entries; ids unique; every `trait_type`/`value` must
exist in traits-reference; a token may omit a trait entirely (that's what a
"None" value or absence means — pick one convention and keep it).

## metadata/traits-reference.json
The truth table the validator reconciles metadata against — every trait, every
value, exact counts. If you don't have counts, generate metadata first and
derive them; the point is that the two files must agree EXACTLY.

```json
{ "schemaVersion": 1, "collection": "<slug>", "source": "how these counts were obtained",
  "traits": { "Background": { "values": { "Blue": 1200, "Red": 800 }, "distinct": 2, "sum": 2000 } } }
```

Rule: every trait's `sum` equals `supply`. (This property proved pixel-lions'
supply six independent ways before we ever touched an API.)

## rarity/rarity.json
Per-token rank, whatever the method. Declare the method honestly:

- `"team-intended"` — the team's own grade/rank list (aDAO's model)
- `"statistical"` — computed from trait frequencies (we can compute this FOR
  you from traits-reference + metadata; ask, or run the tooling)
- `"<marketplace>-mirror"` — mirrored from a marketplace's ranking, gated on
  known anchors (pixel-lions' model)

```json
{ "schemaVersion": 1, "method": "statistical", "source": "…", "sweptAt": "…",
  "records": [ { "token_id": "1", "rank": 4760, "top_percent": 95.2 } ] }
```

Rules: exactly `supply` records; ranks span 1..supply (ties allowed).

## collection.json
See `_template/collection.json` — every field annotated inline. The essentials:

- **Marketplace-agnostic**: the `marketplaces` array takes any venue —
  `{key, token_url, collection_url, royalty_bps}` with `{contract}`/`{id}`
  placeholders. One venue, three, or an empty array are all valid.
- **Backed vs unbacked**: `backing: null` is a first-class state — it turns
  the entire broken/unbroken vocabulary OFF. Backed collections fill the
  treasury/token/per-NFT-rule block (see `adao/`).
- **`null` always means "off / not applicable"** — never guess a value to
  fill a field. The validator treats invented data as the bug it is.

## Validation
`node .github/scripts/validate-collection.js <slug>` — or run the
`validate-collection` Action. It checks structure, supply agreement across all
three data files, exact trait-count reconciliation, rank coverage, and
marketplace URL shape. Green output is the bar for enabling a collection.
