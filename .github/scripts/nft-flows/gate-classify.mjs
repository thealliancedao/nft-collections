// gate-classify.mjs — node gate-classify.mjs <tla-core root>
// Fixtures = the owner's 2026-09-11/12 Pixel Lions + escrow test txs (events transcribed from Chainscope), the 1.1.6 real txs
// (Atrium 301EB8…, Boost 01264EDF… / 01558E…, offers F99054… — events verbatim from the committed raw / FCD parts),
// plus one committed raw part and one committed FCD part when present at the given root.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyNftTx, buildIndex, KIND } = require('./classify.js');
const ROOT = process.argv[2] || '.';
const { loadRegistry } = require('./registry.js');
const reg = loadRegistry(ROOT); const idx = buildIndex(reg);
let pass = 0, fail = 0; const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, x !== undefined ? '→ ' + JSON.stringify(x).slice(0, 220) : ''); } };

const PL = 'terra17z7fpaa8kah698xn5tarrcucvualdy4wsztkfc404g3garucpu6qmxp50g', PLV = 'terra127dehd2d6t7ynnezkxkre2w83ze0t7lmghpu6vn4y5mfmwfj5x9qqdh4sz', DIST = 'terra1krewrx5uye0ux786w9jd2qx4wqz5pz2y5mqxw2k58p4xjhnw5lfqm450m7';
const BBL = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9', ATR = 'terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj', BST = 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at', ESC = 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg';
const ME = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw', W2 = 'terra1d0jq9l5narcgy46v5agnv8hqmn5m8kj3lkh93l', BLUNA = 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml', SOLID = 'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst', AMP = 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct';
const ev = (type, o, mi = 0) => ({ type, msg_index: mi, attributes: Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => ({ key: k, value: String(x) }))) });
const wasm = (c, o, mi = 0) => ev('wasm', Object.assign({ _contract_address: c }, o), mi);
const bank = (from, to, amt, mi = 0) => ev('transfer', { recipient: to, sender: from, amount: amt }, mi);
const tx = (hash, h, t, events, messages) => ({ txhash: hash, height: h, timestamp: t, code: 0, events, messages });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const run = (t) => classifyNftTx(t, reg, idx);
const one = (rs, kind) => rs.filter(r => r.kind === kind);

console.log('\n== BBL (PL #1234) ==');
{ const r = run(tx('BC55', 22794530, '2026-09-11T19:19:10Z', [
    wasm(BLUNA, { action: 'send', from: ME, to: BBL, amount: 40000000 }, 0), wasm(BBL, { action: 'place_bid', auction_id: 17829, bid_amount: 40000000, bidder: ME, nft_contract: PL, token_id: 1234 }, 0),
    wasm(BBL, { action: 'settle', auction_id: 17829, nft_contract: PL, token_id: 1234, denom: BLUNA, amount: 40000000, seller: 'terra1mw650edddjqsz7mwmga0qm688j0wx9mdmu4n0w' }, 1),
    wasm(BLUNA, { action: 'transfer', amount: 800000, from: BBL, to: 'terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75' }, 1), wasm(BLUNA, { action: 'transfer', amount: 2000000, from: BBL, to: 'terra1xgg9cf94ws2mawr6lyrdvmyxt48xkwgp8gvtsrcg2yktqvk8w2rqxflq06' }, 1), wasm(BLUNA, { action: 'transfer', amount: 37200000, from: BBL, to: 'terra1mw650edddjqsz7mwmga0qm688j0wx9mdmu4n0w' }, 1),
    wasm(PL, { action: 'transfer_nft', recipient: ME, sender: BBL, token_id: 1234 }, 1), wasm(BBL, { action: 'settle_hook' }, 1)]));
  const s = one(r, KIND.SALE)[0]; ok(s && s.collection === 'pixel-lions' && s.token_id === '1234' && s.venue === 'bbl', 'buy = sale on bbl for pixel #1234', r.map(x => x.kind));
  ok(s && s.price.amount === '40000000' && s.price.denom === 'cw20:' + BLUNA && s.from === 'terra1mw650edddjqsz7mwmga0qm688j0wx9mdmu4n0w' && s.to === ME, 'sale price 40 bLUNA (cw20: spelling, same as create_auction), seller → buyer', s);
  ok(s && s.split && s.split.legs.length === 3 && s.split.legs.map(l => l.amount).join() === '800000,2000000,37200000', 'split legs 2% / 5% / seller', s && s.split);
  ok(one(r, KIND.BID).length === 1 && one(r, KIND.BID)[0].price.amount === '40000000', 'place_bid recorded as bid');
  const l = run(tx('FAEE', 22794610, '2026-09-11T19:26:45Z', [wasm(PL, { action: 'send_nft', sender: ME, recipient: BBL, token_id: 1234 }), wasm(BBL, { action: 'create_auction', auction_id: 17860, auction_type: 'buy_now', denom: 'cw20:' + BLUNA, nft_contract: PL, reserve: 100000000, seller: ME, token_id: 1234 })]));
  ok(l.length === 1 && l[0].kind === KIND.LIST && l[0].auction_id === '17860' && l[0].price.amount === '100000000' && l[0].price.denom === 'cw20:' + BLUNA, 'list = create_auction 100 bLUNA', l);
  const d = run(tx('B6B3', 22794695, '2026-09-11T19:34:56Z', [wasm(BLUNA, { action: 'send', from: W2, to: BBL, amount: 56000000 }), wasm(BBL, { action: 'deposit', amount: 56000000, from: W2, token: BLUNA })]));
  ok(d.length === 1 && d[0].kind === KIND.DEPOSIT && d[0].from === W2 && d[0].price.amount === '56000000' && d[0].price.denom === 'cw20:' + BLUNA, 'bid-account deposit is a venue_deposit (wallet-level)', d);
  const o = run(tx('0132', 22794704, '2026-09-11T19:35:49Z', [wasm(BBL, { action: 'make_offer', auction_id: 17860, bidder: W2, amount: 50000000 })]));
  ok(o.length === 1 && o[0].kind === KIND.OFFER && o[0].auction_id === '17860' && o[0].from === W2 && o[0].price.amount === '50000000', 'make_offer → offer keyed by auction id', o);
  const c = run(tx('D4C7', 22795462, '2026-09-11T20:48:43Z', [wasm(BBL, { action: 'cancel_auction', auction_id: 17860 }), wasm(PL, { action: 'transfer_nft', recipient: ME, sender: BBL, token_id: 1234 }), wasm(BBL, { action: 'settle_hook' })]));
  ok(c.length === 1 && c[0].kind === KIND.DELIST && c[0].auction_id === '17860' && c[0].to === ME, 'cancel_auction → delist', c);
  const x = run(tx('D881', 22794579, '2026-09-11T19:23:50Z', [wasm(PL, { action: 'transfer_nft', sender: ME, recipient: W2, token_id: 1787 })]));
  ok(x.length === 1 && x[0].kind === KIND.TRANSFER && x[0].from === ME && x[0].to === W2, 'plain transfer (NFTSwitch is a front-end)', x);
}
console.log('\n== DAODAO (PL) ==');
{ const s = run(tx('C9BB', 22795548, '2026-09-11T20:57:02Z', [wasm(PL, { action: 'send_nft', sender: ME, recipient: PLV, token_id: 1234 }), wasm(PLV, { action: 'stake', from: ME, token_id: 1234 }), wasm(DIST, { action: 'stake' })]));
  ok(s.length === 1 && s[0].kind === KIND.STAKE && s[0].custodian === 'daodao_voting', 'send_nft to voting module = stake', s);
  const u = run(tx('1A20', 22795553, '2026-09-11T20:57:31Z', [wasm(PLV, { action: 'unstake', from: ME, claim_duration: 'time: 1' }), wasm(DIST, { action: 'unstake' })], [{ contract: PLV, msg: { unstake: { token_ids: ['1065'] } } }]));
  ok(u.length === 1 && u[0].kind === KIND.UNSTAKE && u[0].token_id === '1065' && u[0].to === ME, 'unstake with msg body → token 1065', u);
  const u2 = run(tx('1A20', 22795553, '2026-09-11T20:57:31Z', [wasm(PLV, { action: 'unstake', from: ME, claim_duration: 'time: 1' })]));
  ok(u2.length === 1 && u2[0].token_id === null && /msg body/.test(u2[0].note), 'unstake without msg body → token null + reason (never invented)', u2);
  const cl = run(tx('9249', 22795559, '2026-09-11T20:58:06Z', [wasm(PL, { action: 'transfer_nft', sender: PLV, recipient: ME, token_id: 1065 })]));
  ok(cl.length === 1 && cl[0].kind === KIND.CLAIM && cl[0].token_id === '1065', 'transfer out of the voting module = claim', cl);
}
console.log('\n== Boost (PL #1065) ==');
{ const setup = b64({ setup: { name: '', to_info: { native: 'uluna' }, setup: { nft: { to_amount: '25000000' } } } });
  const l = run(tx('6A94', 22800597, '2026-09-12T05:03:11Z', [wasm(PL, { action: 'send_nft', sender: ME, recipient: BST, token_id: 1065 }), wasm(BST, { action: 'launch-nft/setup', collection: PL, id: 497, token_id: 1065 })], [{ contract: PL, msg: { send_nft: { contract: BST, token_id: '1065', msg: setup } } }]));
  ok(l.length === 1 && l[0].kind === KIND.LIST && l[0].venue === 'boost' && l[0].listing_id === '497' && l[0].price.amount === '25000000' && l[0].price.denom === 'uluna', 'Boost setup with msg body → list 25 LUNA', l);
  const l2 = run(tx('6A94', 22800597, '2026-09-12T05:03:11Z', [wasm(PL, { action: 'send_nft', sender: ME, recipient: BST, token_id: 1065 }), wasm(BST, { action: 'launch-nft/setup', collection: PL, id: 497, token_id: 1065 })]));
  ok(l2[0].price === null && l2[0].price_reason === 'msg_body_not_archived:price', 'Boost setup without msg body → price null + reason', l2);
  const b = run(tx('A58E', 22800600, '2026-09-12T05:03:29Z', [bank(W2, BST, '25000000uluna'), wasm(BST, { action: 'launch-nft/deposit_nft', id: 497, deposit_amount: 25000000, 'launch-nft/done': 1, protocol_fee_amount: 500000, royalty_amount: 1250000, seller_amount: 23250000 }), wasm(PL, { action: 'transfer_nft', recipient: W2, sender: BST, token_id: 1065 }), bank(BST, 'terra1rppeahhmtvy4fs9xr9zkjrf4xs9ak4ygy62slq', '500000uluna'), bank(BST, 'terra1c690mdrwdetnr09zfk3tf9xz9jhrgd9wpjyf3tuccj74ql09eqmq6sh7en', '1250000uluna'), bank(BST, ME, '23250000uluna')]));
  const s = one(b, KIND.SALE)[0]; ok(s && s.venue === 'boost' && s.price.amount === '25000000' && s.price.denom === 'uluna' && s.to === W2 && s.from === ME, 'Boost deposit_nft → sale 25 LUNA, seller resolved from the seller leg', b);
  ok(s && s.split.fee === '500000' && s.split.royalty === '1250000' && s.split.seller === '23250000' && s.done === '1', 'Boost split from the event', s && s.split);
  const c = run(tx('AB16', 22800609, '2026-09-12T05:04:17Z', [wasm(BST, { action: 'launch-nft/cancel', id: 498 }), wasm(PL, { action: 'transfer_nft', recipient: W2, sender: BST, token_id: 1065 })]));
  ok(c.length === 1 && c[0].kind === KIND.DELIST && c[0].listing_id === '498', 'Boost cancel → delist', c);
}
console.log('\n== Atrium (PL #899, lock #2163) ==');
{ const lm = b64({ price: '25000000', payment: { Cw20: { contract_addr: SOLID } }, expires_in_blocks: 432000 });
  const l = run(tx('ED1B', 22800741, '2026-09-12T05:16:59Z', [wasm(PL, { action: 'send_nft', sender: ME, recipient: ATR, token_id: 899 }), wasm(ATR, { action: 'list_nft', listing_id: 556, nft_contract: PL, price: 25000000, seller: ME, token_id: 899 })], [{ contract: PL, msg: { send_nft: { contract: ATR, token_id: '899', msg: lm } } }]));
  ok(l.length === 1 && l[0].kind === KIND.LIST && l[0].listing_id === '556' && l[0].price.denom === 'cw20:' + SOLID && l[0].expires_in_blocks === 432000, 'Atrium list_nft + msg → 25 SOLID, 30-day expiry', l);
  const rp = run(tx('D936', 22800809, '2026-09-12T05:23:34Z', [wasm(ATR, { action: 'cancel_listing', listing_id: 556, seller: ME, cancelled_by: 'seller' }, 0), wasm(PL, { action: 'transfer_nft', recipient: ME, sender: ATR, token_id: 899 }, 0), wasm(PL, { action: 'send_nft', sender: ME, recipient: ATR, token_id: 899 }, 1), wasm(ATR, { action: 'list_nft', listing_id: 557, nft_contract: PL, price: 2000000, seller: ME, token_id: 899 }, 1)]));
  ok(rp.length === 2 && rp[0].kind === KIND.DELIST && rp[0].cancelled_by === 'seller' && rp[1].kind === KIND.LIST && rp[1].listing_id === '557' && rp[1].price_reason === 'msg_body_not_archived:denom', 'reprice = delist + list (denom null without msg body)', rp);
  const om = b64({ make_offer: { nft_contract: PL, token_id: '899', expires_in_blocks: 100800 } });
  const o = run(tx('9355', 22800831, '2026-09-12T05:25:43Z', [wasm(SOLID, { action: 'send', from: W2, to: ATR, amount: 1000000 }), wasm(ATR, { action: 'make_offer_cw20', amount: 1000000, buyer: W2, cw20: SOLID, offer_id: 12 })], [{ contract: SOLID, msg: { send: { amount: '1000000', contract: ATR, msg: om } } }]));
  ok(o.length === 1 && o[0].kind === KIND.OFFER && o[0].offer_id === '12' && o[0].collection === 'pixel-lions' && o[0].token_id === '899' && o[0].price.denom === 'cw20:' + SOLID, 'Atrium offer escrows 1 SOLID, token from msg', o);
  const a = run(tx('9F70', 22800848, '2026-09-12T05:27:20Z', [wasm(ATR, { action: 'buy_nft', listing_id: 557, buyer: W2, seller: ME, nft_contract: PL, token_id: 899, price: 1000000, fee: 0, effective_fee_bps: 0, royalty: 0, seller_receives: 1000000, accepted_offer_id: 12 }), wasm(SOLID, { action: 'transfer', amount: 1000000, from: ATR, to: ME }), wasm(PL, { action: 'transfer_nft', recipient: W2, sender: ATR, token_id: 899 })]));
  const s = one(a, KIND.SALE)[0]; ok(s && s.via_offer && s.accepted_offer_id === '12' && s.price.amount === '1000000' && s.price.denom === 'cw20:' + SOLID && s.split.royalty === '0' && s.to === W2, 'accept_offer → sale via offer, royalty 0 read not assumed', a);
  const ll = run(tx('2B8E', 22801089, '2026-09-12T05:50:28Z', [wasm(ESC, { action: ['ve/change_lock_owner', 'send_nft'], old_owner: ME, new_owner: ATR, sender: ME, recipient: ATR, token_id: 2163 }), wasm(ATR, { action: 'list_nft', listing_id: 558, nft_contract: ESC, price: 1000000, seller: ME, token_id: 2163 })]));
  ok(ll.length === 1 && ll[0].kind === KIND.LIST && ll[0].collection === 'tla-locks' && ll[0].listing_id === '558', 'lock listed on Atrium = list on tla-locks (custody → seller resolved by inventory)', ll);
  const lc = run(tx('30F2', 22801096, '2026-09-12T05:51:09Z', [wasm(ATR, { action: 'cancel_listing', listing_id: 558, seller: ME, cancelled_by: 'seller' }), wasm(ESC, { action: ['ve/change_lock_owner', 'transfer_nft'], new_owner: ME, old_owner: ATR, recipient: ME, sender: ATR, token_id: 2163 })]));
  ok(lc.length === 1 && lc[0].kind === KIND.DELIST && lc[0].collection === 'tla-locks', 'lock delist', lc);
}
console.log('\n== Escrow lifecycle ==');
{ const w = run(tx('3CCC', 22800959, '2026-09-12T05:37:57Z', [wasm(ESC, { action: ['ve/withdraw', 'burn'], sender: ME, token_id: 1319 }), wasm(AMP, { action: 'transfer', amount: 22224213, from: ESC, to: ME })]));
  ok(w.length === 1 && w[0].kind === KIND.LOCK_WITHDRAW && w[0].token_id === '1319' && w[0].price.amount === '22224213' && w[0].price.denom === 'cw20:' + AMP, 'withdraw #1319 → 22.22 ampLUNA', w);
  const m = run(tx('C223', 22800966, '2026-09-12T05:38:41Z', [wasm(ESC, { action: ['ve/migrate_lock', 'burn'], token_id: 227, fixed_power_before: 11017030, migrate_amount: 'native:uluna:11017030', voting_power: 0, fixed_power: 0, lock_end: 'permanent', sender: ME }), wasm(ESC, { action: ['ve/create_lock', 'mint'], asset: 'cw20:' + AMP + ':4819099', fixed_power: 11200238, lock_end: 'permanent', minter: ESC, owner: ME, token_id: 2161, voting_power: 100802142 })]));
  const mg = one(m, KIND.LOCK_MIGRATE)[0]; ok(mg && mg.lineage.from_ids.join() === '227' && mg.lineage.to_ids.join() === '2161' && mg.migrate.into === 'cw20:' + AMP + ':4819099' && one(m, KIND.LOCK_CREATE).length === 0, 'migrate: lineage 227 → 2161, no duplicate create', m);
  const me = run(tx('373B', 22800974, '2026-09-12T05:39:27Z', [wasm(ESC, { action: ['ve/merge_lock', 'burn'], merge: '151,1157', voting_power: 106767845802, fixed_power: 11863093978, lock_end: 'permanent', sender: ME, token_id: 1157 })]));
  ok(me.length === 1 && me[0].kind === KIND.LOCK_MERGE && me[0].token_id === '151' && me[0].lineage.burned.join() === '1157', 'merge: 1157 folded into 151', me);
  const cr = run(tx('0784', 22800983, '2026-09-12T05:40:20Z', [wasm(AMP, { action: 'send', from: ME, to: ESC, amount: 22224213 }), wasm(ESC, { action: ['ve/create_lock', 'mint'], asset: 'cw20:' + AMP + ':22224213', fixed_power: 51652078, lock_end: 'permanent', minter: ESC, owner: ME, token_id: 2162, voting_power: 464868702 })]));
  ok(cr.length === 1 && cr[0].kind === KIND.LOCK_CREATE && cr[0].token_id === '2162' && cr[0].to === ME && cr[0].lock.lock_end === 'permanent', 'create #2162 permanent', cr);
  const sp = run(tx('9EB9', 22800989, '2026-09-12T05:40:55Z', [wasm(ESC, { action: ['ve/split_lock', 've/create_lock', 'mint'], voting_power: [50401080, 50401053], fixed_power: [5600120, 5600117], lock_end: ['permanent', 'permanent'], asset: 'cw20:' + AMP + ':2409549', minter: ESC, owner: ME, token_id: 2163 }), ev('wasm-metadata_changed', { _contract_address: ESC, token_id: 2161 })]));
  ok(sp.length === 1 && sp[0].kind === KIND.LOCK_SPLIT && sp[0].token_id === '2163' && sp[0].lineage.from_ids.join() === '2161', 'split: 2161 → new 2163 (parent from metadata_changed)', sp);
  const tr = run(tx('651A', 22801005, '2026-09-12T05:42:31Z', [wasm(ESC, { action: ['ve/change_lock_owner', 'transfer_nft'], old_owner: ME, new_owner: W2, sender: ME, recipient: W2, token_id: 2161 })]));
  ok(tr.length === 1 && tr[0].kind === KIND.LOCK_TRANSFER && tr[0].from === ME && tr[0].to === W2, 'transfer = change_lock_owner', tr);
  const ad = run(tx('20BB', 22801016, '2026-09-12T05:43:34Z', [wasm(AMP, { action: 'send', from: ME, to: ESC, amount: 10756688 }), wasm(ESC, { action: 've/deposit_for', fixed_power: 26201547131, lock_end: 'permanent', voting_power: 235813924179 }), ev('wasm-metadata_changed', { _contract_address: ESC, token_id: 118 })]));
  ok(ad.length === 1 && ad[0].kind === KIND.LOCK_ADD && ad[0].token_id === '118' && ad[0].price.amount === '10756688' && ad[0].from === ME, 'extend_lock_amount → lock_add #118 (id from metadata_changed)', ad);
}
console.log('\n== 2023 venues + launchpad ==');
{ const reg2 = JSON.parse(JSON.stringify(reg)); reg2.collections['pixel-lions'].launchpad.address = 'terra1d2gjv4fLAUNCHPAD'; const idx2 = buildIndex(reg2);
  const mp = classifyNftTx(tx('MINT', 5440000, '2023-06-09T12:00:00Z', [bank('terra1buyer', 'terra1d2gjv4fLAUNCHPAD', '30000000uluna'), wasm(PL, { action: 'transfer_nft', sender: 'terra1d2gjv4fLAUNCHPAD', recipient: 'terra1buyer', token_id: 10 }), wasm(PL, { action: 'transfer_nft', sender: 'terra1d2gjv4fLAUNCHPAD', recipient: 'terra1buyer', token_id: 11 }), wasm(PL, { action: 'transfer_nft', sender: 'terra1d2gjv4fLAUNCHPAD', recipient: 'terra1buyer', token_id: 12 })]), reg2, idx2);
  ok(mp.length === 3 && mp.every(r => r.kind === KIND.MINT_PURCHASE && r.price.amount === '10000000' && r.price.denom === 'uluna' && r.price.tokens_in_tx === 3), '3-mint for 30 LUNA → three mint_purchase at 10 LUNA each', mp);
  const am = run(tx('4295', 5430672, '2023-06-09T05:59:59Z', [wasm(PL, { action: 'mint', minter: 'terra18qx2ql4nxlarqvkc6z3pmuhg0m48kpncxl8acc', owner: 'terra1d2gjv4fLAUNCHPAD', token_id: 1 })]));
  ok(am.length === 1 && am[0].kind === KIND.MINT && am[0].to === 'terra1d2gjv4fLAUNCHPAD', 'admin mint into the holder', am);
  const ao = run(tx('F990', 5449456, '2023-06-10T13:25:44Z', [wasm('terra1jg2fkptul8mmzd5rw32pgatrq2dly579sam3yqexufjvqhwaqa5sxf7z7v', { action: 'accept_offer', offer_id: 18, token_id: 4044 }), bank('terra1jg2fkptul8mmzd5rw32pgatrq2dly579sam3yqexufjvqhwaqa5sxf7z7v', 'terra140233z883n43vfqky3klae87n5k7qm3pq2e9eg', '15000000uluna'), wasm(PL, { action: 'transfer_nft', sender: 'terra1jg2fkptul8mmzd5rw32pgatrq2dly579sam3yqexufjvqhwaqa5sxf7z7v', recipient: 'terra1newowner', token_id: 4044 })]));
  const s = one(ao, KIND.SALE)[0]; ok(s && s.venue === 'offers-2023' && s.price.amount === '15000000' && s.offer_id === '18', '2023 offers contract accept_offer → sale 15 LUNA', ao);
  const dw = run(tx('A889', 5455260, '2023-06-10T23:08:21Z', [wasm(PL, { action: 'transfer_nft', sender: 'terra1pyn0fg6r3y0ca5vkv3u60f94mwmne64ylunhsh', recipient: 'terra1ksn7v2nfjqkzkkhcuvk9n8pgj4aqcmfsy38ws7', token_id: 1301 })]));
  ok(dw.length === 1 && dw[0].kind === KIND.TRANSFER && /distribution/.test(dw[0].note), 'distribution wallet multisend labeled, not a sale', dw);
}
console.log('\n== 1.1.5: several launchpads + stock returns (aDAO candy machines) ==');
{ const ADAO = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9', STOCK = 'terra1g0mfrpswewteaf9ky4rlj09wh5njp6u9xxk94uszplw4qz2f9mzq3k27fm', CM75 = 'terra17tg0lk3l9luhata3h03zcp2ecave5n4l5x8akpdzu5lrydegwdzqxyj09c', CM130 = 'terra1jw84ef5qye2zykelyenchnfzkmrznguy5ym9aa4kxte7h0c5m4ysxfte89', PROCEEDS = 'terra1nrtsk4nv9g9pfmc7ymw6w04z098xcgejg0xa0y', DAO = 'terra17c6ts8grcfrgquhj3haclg44le8s7qkx6l2yx33acguxhpf000xqhnl3je';
  const a = reg.collections.adao; ok(a && a.launchpad && Array.isArray(a.launchpad.addresses) && a.launchpad.addresses.length === 3 && (a.distribution_wallets || []).includes(STOCK), 'adao registry: launchpad.addresses = 3 candy machines, treasury stock is a distribution wallet', a && a.launchpad);
  ok(idx.launchByAddr[CM75] === 'adao' && idx.launchByAddr[CM130] === 'adao' && idx.distByAddr[STOCK] === 'adao', 'buildIndex: every launchpad address + the distribution wallet indexed');
  const paid = run(tx('E164', 10584886, '2024-06-01T22:28:58Z', [bank('terra1buyer', CM130, '100000000uluna'), wasm(CM130, { action: 'mint' }), bank(CM130, PROCEEDS, '100000000uluna'), wasm(ADAO, { action: 'transfer_nft', sender: CM130, recipient: 'terra1buyer', token_id: 716 })]));
  ok(paid.length === 1 && paid[0].kind === KIND.MINT_PURCHASE && paid[0].price.amount === '100000000' && paid[0].price.denom === 'uluna' && paid[0].to === 'terra1buyer' && paid[0].from === CM130, 'candy machine → buyer with 100 LUNA attached = mint_purchase 100 LUNA (Phase 2b round 1)', paid);
  const gov = run(tx('D1A9', 9237336, '2024-02-29T01:01:39Z', [wasm(DAO, { action: 'execute_cosmos_msgs' }), bank(DAO, CM75, '75000000uluna'), wasm(CM75, { action: 'mint' }), bank(CM75, PROCEEDS, '75000000uluna'), wasm(ADAO, { action: 'transfer_nft', sender: CM75, recipient: DAO, token_id: 3022 })]));
  ok(gov.length === 1 && gov[0].kind === KIND.MINT_PURCHASE && gov[0].price.amount === '75000000' && gov[0].to === DAO, 'a DAO treasury minting through a governance proposal is still a paid mint (75 LUNA)', gov);
  const load = run(tx('9472', 10583944, '2024-06-01T20:52:20Z', [wasm(ADAO, { action: 'transfer_nft', sender: STOCK, recipient: CM130, token_id: 5441 })]));
  ok(load.length === 1 && load[0].kind === KIND.TRANSFER && /distribution/.test(load[0].note), 'treasury stock → candy machine = transfer (primary distribution wallet), never a $0 mint_purchase', load);
  const back = run(tx('RET1', 10700000, '2024-06-20T00:00:00Z', [wasm(ADAO, { action: 'transfer_nft', sender: CM75, recipient: STOCK, token_id: 2222 })]));
  ok(back.length === 1 && back[0].kind === KIND.TRANSFER && /returned/.test(back[0].note), 'candy machine → treasury stock (unsold) = transfer, not a sale', back);
  const hop = run(tx('HOP1', 10700001, '2024-06-20T00:00:01Z', [wasm(ADAO, { action: 'transfer_nft', sender: CM75, recipient: CM130, token_id: 2223 })]));
  ok(hop.length === 1 && hop[0].kind === KIND.TRANSFER && /returned/.test(hop[0].note), 'candy machine → another candy machine = transfer', hop);
  const free = run(tx('FREE', 10700002, '2024-06-20T00:00:02Z', [wasm(ADAO, { action: 'transfer_nft', sender: CM130, recipient: 'terra1someone', token_id: 2224 })]));
  ok(free.length === 1 && free[0].kind === KIND.MINT_PURCHASE && free[0].price.amount === '0' && /free_or_admin/.test(free[0].price_reason), 'candy machine → a wallet with no payment leg stays a $0 mint_purchase with price_reason (never invents a price)', free);
}
console.log('\n== 1.1.6: msg_index from the event ATTRIBUTE (raw parts) · venue event paired to its token · cw20 transfer_from legs · offer seller ==');
{ // raw-shaped events: NO msg_index field, the index rides as an attribute (tx_search / block results, SDK 0.47+)
  const rev = (c, o, mi) => ({ type: 'wasm', attributes: Object.entries(Object.assign({ _contract_address: c }, o, mi == null ? {} : { msg_index: mi })).map(([k, v]) => ({ key: k, value: String(v) })) });
  const rbank = (from, to, amt, mi) => ({ type: 'transfer', attributes: Object.entries(Object.assign({ recipient: to, sender: from, amount: amt }, mi == null ? {} : { msg_index: mi })).map(([k, v]) => ({ key: k, value: String(v) })) });
  const ADAO = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9', SELLER = 'terra1eykdj5xp2tgcauryaj65dc0d7dnu0ze2gt72wy';
  // real tx 301EB8… (2026-08-21): Atrium price update = cancel_listing 546 (msg 0) + list_nft 547 (msg 1) in ONE tx
  const atr = run(tx('301EB8', 22456000, '2026-08-21T14:35:25Z', [rbank(SELLER, 'terra17xpfvakm2amg962yls6f84z3kell8c5lkaeqfa', '9320uluna'),
    rev(ATR, { action: 'cancel_listing', listing_id: 546, seller: SELLER, cancelled_by: 'seller' }, 0), rev(ADAO, { action: 'transfer_nft', recipient: SELLER, sender: ATR, token_id: 6192 }, 0),
    rev(ADAO, { action: 'send_nft', sender: SELLER, recipient: ATR, token_id: 6192 }, 1), rev(ATR, { action: 'list_nft', listing_id: 547, nft_contract: ADAO, price: 49900000, seller: SELLER, token_id: 6192 }, 1)]));
  const ad = one(atr, KIND.DELIST)[0], al = one(atr, KIND.LIST)[0];
  ok(ad && ad.msg_index === 0 && ad.listing_id === '546', 'Atrium cancel (msg 0) keeps id 546', ad);
  ok(al && al.msg_index === 1 && al.listing_id === '547' && al.price && al.price.amount === '49900000', 'Atrium list (msg 1) reads ITS list_nft: id 547, 49.9 — not the cancel event (1.1.5: no id, no price)', al);
  ok(al && al.price.denom === null && al.price_reason === 'msg_body_not_archived:denom', 'list_nft carries no denom in events → null + reason (msg body only; resolve-msg-bodies)', al);
  // real tx 01264EDF… (2025-04-01): six Boost setups in one tx, NO msg_index at all (pre-attribute era) — each token gets its own id
  const toks = [[1436, 246], [1959, 247], [3920, 248], [4953, 249], [4089, 250], [2941, 251], [121, 252]];
  const bst = run(tx('01264E', 14968225, '2025-04-01T07:53:54Z', [rbank('terra1aaxprs78gfa6xnahm8jp73eps75kfe4grt2uy8', 'terra1xx', '31807uluna'),
    ...toks.flatMap(([t, id]) => [rev(PL, { action: 'send_nft', sender: 'terra1aaxprs78gfa6xnahm8jp73eps75kfe4grt2uy8', recipient: BST, token_id: t }), rev(BST, { action: 'launch-nft/setup', collection: PL, id, token_id: t })])]));
  ok(bst.length === 7 && bst.every(r => r.kind === KIND.LIST && r.venue === 'boost'), 'Boost multi-token tx → 7 lists', bst.map(r => r.kind));
  ok(toks.every(([t, id]) => bst.some(r => r.token_id === String(t) && r.listing_id === String(id))), 'every token paired to ITS setup id (1.1.5 gave all seven id 246 → market-history dropped six as "ref seen")', bst.map(r => [r.token_id, r.listing_id]));
  // real tx 01558E… (2025-08-13): Boost sale paid in SOLID through cw20 transfer_from (allowance pull) — the denom is that leg's contract
  const BUYER = 'terra1t2v52y6sazlewjpxg6vdy62u9dn23txl7hrn8m';
  const sol = run(tx('01558E', 16900000, '2025-08-13T00:07:48Z', [rev(SOLID, { action: 'increase_allowance', owner: BUYER, spender: BST, amount: 1000000 }, 0),
    rev(BST, { action: 'launch-nft/deposit_nft', id: 395, deposit_amount: 1000000, 'launch-nft/done': 1, protocol_fee_amount: 20000, royalty_amount: 50000, seller_amount: 930000 }, 1),
    rev(SOLID, { action: 'transfer_from', amount: 1000000, by: BST, from: BUYER, to: BST }, 1), rev(ADAO, { action: 'transfer_nft', recipient: BUYER, sender: BST, token_id: 8149 }, 1),
    rev(SOLID, { action: 'transfer', amount: 20000, from: BST, to: 'terra1rppeahhmtvy4fs9xr9zkjrf4xs9ak4ygy62slq' }, 1), rev(SOLID, { action: 'transfer', amount: 50000, from: BST, to: 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm' }, 1), rev(SOLID, { action: 'transfer', amount: 930000, from: BST, to: ME }, 1)]));
  const ss = one(sol, KIND.SALE)[0];
  ok(sol.length === 1 && ss && ss.msg_index === 1 && ss.token_id === '8149' && ss.listing_id === '395', 'Boost cw20 sale is one record at msg 1 (the allowance msg yields nothing)', sol.map(r => [r.kind, r.msg_index]));
  ok(ss && ss.price.amount === '1000000' && ss.price.denom === 'cw20:' + SOLID && ss.from === ME && ss.to === BUYER, 'price 1 SOLID from the transfer_from leg (1.1.5: denom null → unpriced); seller from the 930000 payout; buyer = recipient', ss && ss.price);
  // real tx F99054… (2023-06-10): 2023 offers contract accept_offer — the seller is whom the contract pays (legacy flattened event, FCD msg_index field)
  const OFF = 'terra1jg2fkptul8mmzd5rw32pgatrq2dly579sam3yqexufjvqhwaqa5sxf7z7v', OSELLER = 'terra140233z883n43vfqky3klae87n5k7qm3pq2e9eg', OBUYER = 'terra16vkwszhw877vz0lc2glyx56hs4r0sy7v3h2plt';
  const off = run(tx('F99054', 5449456, '2023-06-10T13:25:44Z', [wasm(PL, { action: 'approve', sender: OSELLER, spender: OFF, token_id: 4044 }, 0), bank(OFF, OSELLER, '15000000uluna', 1),
    { type: 'wasm', msg_index: 1, attributes: [['_contract_address', OFF], ['action', 'accept_offer'], ['offer_id', '18'], ['token_id', '4044'], ['_contract_address', PL], ['action', 'transfer_nft'], ['recipient', OBUYER], ['sender', OFF], ['token_id', '4044']].map(([key, value]) => ({ key, value })) }]));
  const os = one(off, KIND.SALE)[0];
  ok(os && os.from === OSELLER && os.to === OBUYER && os.price.amount === '15000000' && os.offer_id === '18', 'accept_offer sale names the seller = payout recipient (1.1.5: from null)', os);
  // the field still wins when both are present, and a tx with neither groups as msg 0
  const both = run(tx('BOTH', 1, '2026-01-01T00:00:00Z', [{ type: 'wasm', msg_index: 2, attributes: [{ key: '_contract_address', value: PL }, { key: 'action', value: 'transfer_nft' }, { key: 'sender', value: 'terra1a' }, { key: 'recipient', value: 'terra1b' }, { key: 'token_id', value: '7' }, { key: 'msg_index', value: '5' }] }]));
  ok(both.length === 1 && both[0].msg_index === 2, 'msg_index FIELD wins over the attribute when both exist', both);
  const none = run(tx('NONE', 1, '2026-01-01T00:00:00Z', [rev(PL, { action: 'transfer_nft', sender: 'terra1a', recipient: 'terra1b', token_id: 8 })]));
  ok(none.length === 1 && none[0].msg_index === 0, 'no field, no attribute → msg 0 (pre-attribute raw parts unchanged)', none);
}
console.log('\n== 1.1.6 (e): msg bodies paired by token / position (resolve-msg-bodies, walks ≥ 1.5.0) ==');
{ const rev = (c, o, mi) => ({ type: 'wasm', attributes: Object.entries(Object.assign({ _contract_address: c }, o, mi == null ? {} : { msg_index: mi })).map(([k, v]) => ({ key: k, value: String(v) })) });
  const S = 'terra1aaxprs78gfa6xnahm8jp73eps75kfe4grt2uy8'; const setup = (amt) => ({ setup: { to_info: { native: 'uluna' }, setup: { nft: { to_amount: String(amt) } } } });
  const toks = [[1436, 246, 25000000], [1959, 247, 30000000], [121, 252, 99000000]];
  // pre-attribute part (no msg_index anywhere) + bodies fetched by hash: every token must price from ITS send_nft body
  const t = tx('01264E', 14968225, '2025-04-01T07:53:54Z', toks.flatMap(([id, lid]) => [rev(PL, { action: 'send_nft', sender: S, recipient: BST, token_id: id }), rev(BST, { action: 'launch-nft/setup', collection: PL, id: lid, token_id: id })]),
    toks.map(([id, , amt]) => ({ '@type': '/cosmwasm.wasm.v1.MsgExecuteContract', sender: S, contract: PL, msg: { send_nft: { contract: BST, token_id: String(id), msg: b64(setup(amt)) } }, funds: [] })));
  const r = run(t);
  ok(r.length === 3 && toks.every(([id, lid, amt]) => r.some(x => x.kind === KIND.LIST && x.token_id === String(id) && x.listing_id === String(lid) && x.price && x.price.amount === String(amt) && x.price.denom === 'uluna' && !x.price_reason)), 'Boost multi-token listing in ONE group: each token priced from its own body (25 / 30 / 99 LUNA), not messages[0] for all', r.map(x => [x.token_id, x.listing_id, x.price && x.price.amount]));
  // the same bodies with attribute-era msg_index: identical result (the token lookup does not depend on the index)
  const t2 = tx('01264F', 14968225, '2025-04-01T07:53:54Z', toks.flatMap(([id, lid], i) => [rev(PL, { action: 'send_nft', sender: S, recipient: BST, token_id: id }, i), rev(BST, { action: 'launch-nft/setup', collection: PL, id: lid, token_id: id }, i)]), t.messages);
  const r2 = run(t2); ok(r2.length === 3 && r2.every((x, i) => x.msg_index === i) && toks.every(([id, , amt]) => r2.some(x => x.token_id === String(id) && x.price.amount === String(amt))), 'same tx with msg_index attributes → three groups, same prices, true indices', r2.map(x => [x.msg_index, x.token_id, x.price && x.price.amount]));
  // two DAODAO unstakes in one pre-attribute group: k-th unstake event ↔ k-th unstake message
  const u = run(tx('9FE074', 13783553, '2025-01-10T00:00:00Z', [rev(PLV, { action: 'unstake', from: 'terra1rerw0v', claim_duration: '604800' }), rev(PLV, { action: 'unstake', from: 'terra1rerw0v', claim_duration: '604800' })],
    [{ '@type': '/cosmwasm.wasm.v1.MsgExecuteContract', sender: 'terra1rerw0v', contract: PLV, msg: { unstake: { token_ids: ['77', '78'] } }, funds: [] }, { '@type': '/cosmwasm.wasm.v1.MsgExecuteContract', sender: 'terra1rerw0v', contract: PLV, msg: { unstake: { token_ids: ['900'] } }, funds: [] }]));
  ok(u.length === 3 && u.map(x => x.token_id).join() === '77,78,900' && u.every(x => x.kind === KIND.UNSTAKE && !x.note), 'two unstake events in one group → 77, 78 from the first message, 900 from the second (no duplicated ids, no "resolve at claim" note)', u.map(x => [x.token_id, x.note]));
  const u0 = run(tx('9FE075', 13783553, '2025-01-10T00:00:00Z', [rev(PLV, { action: 'unstake', from: 'terra1rerw0v', claim_duration: '604800' })]));
  ok(u0.length === 1 && u0[0].token_id === null && /msg body/.test(u0[0].note), 'no body at all → one token-less unstake with the honest note (unchanged)', u0);
}
console.log('\n== committed archives (when present) ==');
{ const rawDir = path.join(ROOT, 'tla-locks/raw/17005824-17455823'); const fcd = path.join(ROOT, 'adao/archive/fcd/collection/part-00001.json.gz');
  if (fs.existsSync(path.join(rawDir, 'part-00000.json.gz'))) { const part = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(rawDir, 'part-00000.json.gz')))); const recs = part.flatMap(p => classifyNftTx({ txhash: p.x, height: p.h, timestamp: p.t, code: p.c, events: p.e }, reg, idx)); const by = {}; recs.forEach(r => { by[r.collection + ':' + r.kind] = (by[r.collection + ':' + r.kind] || 0) + 1; }); console.log('    raw part 2025-08:', JSON.stringify(by)); ok(recs.some(r => r.collection === 'tla-locks') && recs.some(r => r.collection === 'adao' && r.kind === 'backing_add' && r.backing.lst_minted === '1024898249'), 'raw part yields lock records + the aDAO backing_add (1,024.9 ampLUNA)'); ok(recs.every(r => r.kind !== KIND.SALE || r.price), 'every sale from raw carries a price'); }
  else console.log('    (raw part not present at root — skipped)');
  if (fs.existsSync(fcd)) { const part = JSON.parse(zlib.gunzipSync(fs.readFileSync(fcd))); const recs = part.txs.flatMap(t => classifyNftTx(t, reg, idx)); const by = {}; recs.forEach(r => { by[r.kind] = (by[r.kind] || 0) + 1; }); console.log('    fcd part adao 2025-01:', JSON.stringify(by)); const lists = recs.filter(r => r.kind === KIND.LIST && r.venue === 'atrium'); ok(recs.length > 0 && (!lists.length || lists.every(l => l.price && l.price.denom)), 'FCD part: Atrium listings carry denom from the archived msg body'); }
  else console.log('    (fcd part not present at root — skipped)');
}
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
