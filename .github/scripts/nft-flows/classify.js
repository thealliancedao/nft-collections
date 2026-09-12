'use strict';
// <<NFT FLOWS CLASSIFIER v1>> — 2026-09-12 — SPEC-nft-flows.md
// ONE copy. derive.js and walk.js both require() this file; platform-crons will
// vendor it byte-identical when forward capture moves over (diff-gate it then).
//
// Input: a tx { txhash, height, timestamp, code, events:[{type,attributes:[{key,value}],msg_index?}], messages?:[{contract,msg}] }
// and the collection registry (docs/curated/nft-collections.json).
// Output: flow records, one per (collection, token, kind, msg_index):
//   { collection, token_id, kind, venue, from, to, custodian, price:{amount,denom}|null,
//     listing_id|auction_id|offer_id, split:{fee,royalty,seller}|null, lineage:{from_ids,to_ids}|null,
//     txhash, height, ts, msg_index, note?, price_reason? }
// LAWS: events are truth; msg bodies (FCD only) enrich — never invent a price the tx did not carry
//       (price:null + price_reason instead). Every record names its venue/custodian by registry label, never by guess.

const KIND = {
  MINT: 'mint', MINT_PURCHASE: 'mint_purchase', TRANSFER: 'transfer', BREAK: 'break', BURN: 'burn',
  STAKE: 'stake', UNSTAKE: 'unstake', CLAIM: 'claim', STAKE_ENTERPRISE: 'stake_enterprise', UNSTAKE_ENTERPRISE: 'unstake_enterprise',
  LIST: 'list', DELIST: 'delist', SALE: 'sale', BID: 'bid', OFFER: 'offer', OFFER_CANCEL: 'offer_cancel',
  DEPOSIT: 'venue_deposit', WITHDRAW: 'venue_withdraw', VENUE_IN: 'venue_in', VENUE_OUT: 'venue_out', BACKING_ADD: 'backing_add',
  // escrow (TLA locks)
  LOCK_CREATE: 'lock_create', LOCK_ADD: 'lock_add', LOCK_EXTEND: 'lock_extend', LOCK_PERMANENT: 'lock_permanent', LOCK_UNPERMANENT: 'lock_unpermanent',
  LOCK_MERGE: 'lock_merge', LOCK_SPLIT: 'lock_split', LOCK_MIGRATE: 'lock_migrate', LOCK_WITHDRAW: 'lock_withdraw', LOCK_TRANSFER: 'lock_transfer',
};

function attrsAll(ev) { const o = {}; for (const a of (ev.attributes || [])) (o[a.key] ||= []).push(a.value); return o; }
function first(o, k) { return o[k] ? o[k][0] : undefined; }
function b64json(s) { try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; } }

// Build lookup tables once per registry.
function buildIndex(reg) {
  const venueByAddr = {}; for (const [k, v] of Object.entries(reg.venues || {})) venueByAddr[v.address] = { key: k, ...v };
  const colByAddr = {}; const custByAddr = {}; const launchByAddr = {}; const distByAddr = {};
  for (const [k, c] of Object.entries(reg.collections || {})) {
    colByAddr[c.collection] = { key: k, ...c };
    for (const [a, cu] of Object.entries(c.custodians || {})) custByAddr[a] = { collection: k, ...cu };
    if (c.launchpad && c.launchpad.address) launchByAddr[c.launchpad.address] = k;
    for (const a of (c.distribution_wallets || [])) distByAddr[a] = k;
  }
  return { venueByAddr, colByAddr, custByAddr, launchByAddr, distByAddr };
}

// Group a tx's events by msg_index (raw parts carry msg_index on each event; FCD parts too).
function byMsg(events) {
  const m = new Map();
  for (const e of events || []) { const i = e.msg_index == null ? 0 : Number(e.msg_index); if (!m.has(i)) m.set(i, []); m.get(i).push(e); }
  return m;
}
// Legacy (pre-0.47, 2023-era FCD) txs emit ONE flattened wasm event per message with every contract call's attributes
// appended after its own `_contract_address` key. Split those at each `_contract_address` so every call reads on its own.
function splitLegacyWasm(e) {
  const at = e.attributes || []; const cuts = []; at.forEach((a, i) => { if (a.key === '_contract_address') cuts.push(i); });
  if (cuts.length <= 1) return [e];
  return cuts.map((c, k) => ({ type: 'wasm', msg_index: e.msg_index, attributes: at.slice(c, k + 1 < cuts.length ? cuts[k + 1] : at.length) }));
}
function wasmOf(events) { return (events || []).filter(e => e.type === 'wasm').flatMap(splitLegacyWasm).map(e => ({ a: attrsAll(e), e })); }
function contractOf(w) { return first(w.a, '_contract_address'); }
function actionsOf(w) { return w.a.action || []; }

// Payment legs inside one msg: native transfers (bank) + cw20 transfers.
function paymentLegs(events) {
  const legs = [];
  for (const e of events || []) {
    if (e.type === 'transfer') { const a = attrsAll(e); const amt = first(a, 'amount'); const to = first(a, 'recipient'), from = first(a, 'sender'); if (amt && to) for (const part of amt.split(',')) { const m = part.match(/^(\d+)(.+)$/); if (m) legs.push({ from, to, amount: m[1], denom: m[2] }); } }
    if (e.type === 'wasm') for (const se of splitLegacyWasm(e)) { const a = attrsAll(se); if ((a.action || []).some(x => x === 'transfer' || x === 'send') && a.amount && a.from && a.to && !a.token_id) legs.push({ from: first(a, 'from'), to: first(a, 'to'), amount: first(a, 'amount'), denom: 'cw20:' + first(a, '_contract_address') }); }
  }
  return legs;
}

function msgBodyFor(tx, msgIndex) { const m = tx.messages && tx.messages[msgIndex]; return m && m.msg ? m.msg : null; }
function innerSendNftMsg(body) { const s = body && (body.send_nft || body.send); return s && s.msg ? b64json(s.msg) : null; }
function denomLabel(d) { if (!d) return null; if (d.startsWith('cw20:')) return d; if (/^terra1[0-9a-z]{58}$/.test(d)) return 'cw20:' + d; return d; }   // BBL settle emits a bare cw20 address; create_auction emits cw20:… — one spelling

// ---------------------------------------------------------------- main
function classifyNftTx(tx, reg, idx) {
  idx = idx || buildIndex(reg);
  const out = [];
  if (tx.code) return out;   // failed txs carry no state change
  const groups = byMsg(tx.events);
  for (const [mi, evs] of groups) {
    const W = wasmOf(evs); const legs = paymentLegs(evs); const body = msgBodyFor(tx, mi); const inner = innerSendNftMsg(body);
    const base = { txhash: tx.txhash, height: tx.height, ts: tx.timestamp, msg_index: mi };
    const push = (r) => out.push(Object.assign({}, base, r));

    // ----- venue-level (no token): BBL deposit / withdraw, offers --------------------------------
    for (const w of W) {
      const c = contractOf(w); const v = idx.venueByAddr[c]; if (!v) continue;
      const acts = actionsOf(w);
      if (acts.includes('deposit') && first(w.a, 'from')) push({ kind: KIND.DEPOSIT, venue: v.key, collection: null, from: first(w.a, 'from'), to: c, price: { amount: first(w.a, 'amount'), denom: first(w.a, 'token') ? 'cw20:' + first(w.a, 'token') : (legs.find(l => l.to === c) || {}).denom || null } });
      if (acts.some(x => /^withdraw/.test(x)) && (first(w.a, 'to') || first(w.a, 'receiver'))) push({ kind: KIND.WITHDRAW, venue: v.key, collection: null, from: c, to: first(w.a, 'to') || first(w.a, 'receiver'), price: { amount: first(w.a, 'amount'), denom: first(w.a, 'token') ? 'cw20:' + first(w.a, 'token') : null } });
      if (acts.includes('make_offer') || acts.includes('make_offer_cw20')) {
        const tok = inner && inner.make_offer ? inner.make_offer : (body && body.make_offer) || {};
        push({ kind: KIND.OFFER, venue: v.key, collection: tok.nft_contract && idx.colByAddr[tok.nft_contract] ? idx.colByAddr[tok.nft_contract].key : null, token_id: tok.token_id || null,
          auction_id: first(w.a, 'auction_id') || null, offer_id: first(w.a, 'offer_id') || null, from: first(w.a, 'bidder') || first(w.a, 'buyer'), to: c,
          price: { amount: first(w.a, 'amount'), denom: first(w.a, 'cw20') ? 'cw20:' + first(w.a, 'cw20') : (legs.find(l => l.to === c) || {}).denom || null },
          note: first(w.a, 'auction_id') ? 'offer on an auction id — resolve token via create_auction' : undefined });
      }
      if (acts.some(x => /cancel_offer|revoke_offer|withdraw_offer/.test(x))) push({ kind: KIND.OFFER_CANCEL, venue: v.key, collection: null, offer_id: first(w.a, 'offer_id') || null, auction_id: first(w.a, 'auction_id') || null, from: first(w.a, 'bidder') || first(w.a, 'buyer') || first(w.a, 'sender') });
      if (acts.includes('place_bid')) { const col = idx.colByAddr[first(w.a, 'nft_contract')]; push({ kind: KIND.BID, venue: v.key, collection: col ? col.key : null, token_id: first(w.a, 'token_id') || null, auction_id: first(w.a, 'auction_id'), from: first(w.a, 'bidder'), price: { amount: first(w.a, 'bid_amount') || first(w.a, 'amount'), denom: (legs.find(l => l.to === c) || {}).denom || null } }); }
    }

    // ----- token-level: walk every cw721 move on a registered collection ------------------------
    for (const w of W) {
      const c = contractOf(w); const col = idx.colByAddr[c]; if (!col) continue;
      const acts = actionsOf(w); const a = w.a; const token = first(a, 'token_id');
      const isEscrow = col.kind === 'escrow';

      // escrow-native actions (ve/*) come first — they carry the lock semantics
      if (isEscrow) {
        const ve = acts.filter(x => x.startsWith('ve/'));
        const msgHasRestructure = W.some(x => contractOf(x) === c && actionsOf(x).some(y => y === 've/migrate_lock' || y === 've/split_lock'));   // create_lock inside a migrate/split is the child, not a new lock
        for (const act of ve) {
          const lock = { fixed_power: first(a, 'fixed_power') || null, voting_power: first(a, 'voting_power') || null, lock_end: first(a, 'lock_end') || null, asset: first(a, 'asset') || null };
          if (act === 've/create_lock' && !msgHasRestructure) push({ kind: KIND.LOCK_CREATE, collection: col.key, token_id: token, to: first(a, 'owner'), lock });
          if (act === 've/withdraw') push({ kind: KIND.LOCK_WITHDRAW, collection: col.key, token_id: token, from: first(a, 'sender'), price: (legs.find(l => l.from === c) || null) && { amount: legs.find(l => l.from === c).amount, denom: legs.find(l => l.from === c).denom } });
          if (act === 've/deposit_for') { const md = evs.find(e => e.type === 'wasm-metadata_changed'); push({ kind: KIND.LOCK_ADD, collection: col.key, token_id: md ? first(attrsAll(md), 'token_id') : token || null, from: (legs.find(l => l.to === c) || {}).from || null, price: legs.find(l => l.to === c) ? { amount: legs.find(l => l.to === c).amount, denom: legs.find(l => l.to === c).denom } : null, lock }); }
          if (/^ve\/extend_lock_time/.test(act)) push({ kind: KIND.LOCK_EXTEND, collection: col.key, token_id: token || null, lock });
          if (/^ve\/(lock_permanent|make_permanent)/.test(act)) push({ kind: KIND.LOCK_PERMANENT, collection: col.key, token_id: token || null, lock });
          if (/^ve\/(unlock_permanent|remove_permanent)/.test(act)) push({ kind: KIND.LOCK_UNPERMANENT, collection: col.key, token_id: token || null, lock });
          if (act === 've/merge_lock') { const ids = (first(a, 'merge') || '').split(',').filter(Boolean); push({ kind: KIND.LOCK_MERGE, collection: col.key, token_id: ids[0] || null, from: first(a, 'sender'), lineage: { from_ids: ids, to_ids: ids.slice(0, 1), burned: ids.slice(1) }, lock }); }
          if (act === 've/split_lock') { const newId = first(a, 'token_id'); const srcId = (body && body.split_lock && body.split_lock.token_id) || null; push({ kind: KIND.LOCK_SPLIT, collection: col.key, token_id: newId || null, to: first(a, 'owner'), lineage: { from_ids: srcId ? [srcId] : [], to_ids: newId ? [newId] : [], source_unknown: !srcId ? 'msg body not archived — parent id from wasm-metadata_changed' : undefined }, lock }); const md = evs.filter(e => e.type === 'wasm-metadata_changed').map(e => first(attrsAll(e), 'token_id')).filter(x => x && x !== newId); if (!srcId && md.length) out[out.length - 1].lineage.from_ids = md; }
          if (act === 've/migrate_lock') { const oldId = first(a, 'token_id'); const mint = a.token_id && a.token_id.length > 1 ? a.token_id[1] : null; const cl = W.find(x => contractOf(x) === c && actionsOf(x).includes('ve/create_lock') && x !== w); const newId = mint || (cl && first(cl.a, 'token_id')) || null; push({ kind: KIND.LOCK_MIGRATE, collection: col.key, token_id: newId || oldId, from: first(a, 'sender'), lineage: { from_ids: [oldId], to_ids: newId ? [newId] : [] }, migrate: { amount_before: first(a, 'migrate_amount') || null, fixed_power_before: first(a, 'fixed_power_before') || null, into: (cl && first(cl.a, 'asset')) || null }, lock: cl ? { fixed_power: first(cl.a, 'fixed_power'), voting_power: first(cl.a, 'voting_power'), lock_end: first(cl.a, 'lock_end'), asset: first(cl.a, 'asset') } : lock }); }
          if (act === 've/change_lock_owner') { /* handled below with the cw721 move so the venue/custodian is resolved once */ }
        }
      }

      if (acts.includes('stake_reward_callback') && first(a, 'tokens_to_stake')) { const amp = W.find(x => actionsOf(x).includes('mint') && first(x.a, 'to') === c && contractOf(x) !== c); push({ kind: KIND.BACKING_ADD, collection: col.key, token_id: null, backing: { luna_staked: first(a, 'tokens_to_stake'), lst_minted: amp ? first(amp.a, 'amount') : null, lst: amp ? 'cw20:' + contractOf(amp) : null } }); continue; }
      const mint = acts.includes('mint') && !isEscrow;
      const xfer = acts.includes('transfer_nft') || acts.includes('send_nft');
      const brk = col.break_action && acts.includes(col.break_action);
      const burn = acts.includes('burn') && !isEscrow;
      if (brk) push({ kind: KIND.BREAK, collection: col.key, token_id: token, from: first(a, 'sender') || first(a, 'owner') });
      else if (burn) push({ kind: KIND.BURN, collection: col.key, token_id: token, from: first(a, 'sender') });
      if (mint) push({ kind: KIND.MINT, collection: col.key, token_id: token, to: first(a, 'owner'), from: first(a, 'minter') || null });
      if (!xfer || !token) continue;

      const from = first(a, 'sender'), to = first(a, 'recipient');
      const vIn = idx.venueByAddr[to], vOut = idx.venueByAddr[from];
      const cuIn = idx.custByAddr[to], cuOut = idx.custByAddr[from];
      const venueW = (addr) => W.find(x => contractOf(x) === addr);   // the venue's own wasm event in this msg

      if (vIn) {   // ---- into a venue = listing (or 2023 trade/offer escrow)
        const vw = venueW(to); const va = vw ? vw.a : {}; const vacts = vw ? actionsOf(vw) : [];
        let price = null, reason, id = {};
        if (vacts.includes('create_auction')) { price = { amount: first(va, 'reserve'), denom: denomLabel(first(va, 'denom')) }; id = { auction_id: first(va, 'auction_id'), auction_type: first(va, 'auction_type') }; }
        else if (vacts.includes('list_nft')) { const pay = inner && inner.payment; price = { amount: first(va, 'price'), denom: pay ? (pay.Cw20 ? 'cw20:' + pay.Cw20.contract_addr : pay.Native ? pay.Native.denom : null) : null }; if (!price.denom) reason = 'msg_body_not_archived:denom'; id = { listing_id: first(va, 'listing_id'), expires_in_blocks: inner && inner.expires_in_blocks != null ? inner.expires_in_blocks : null }; }
        else if (vacts.some(x => /launch-nft\/setup/.test(x))) { const s = inner && inner.setup; price = s && s.setup && s.setup.nft ? { amount: s.setup.nft.to_amount, denom: s.to_info && s.to_info.native ? s.to_info.native : (s.to_info && s.to_info.cw20 ? 'cw20:' + s.to_info.cw20 : null) } : null; if (!price) reason = 'msg_body_not_archived:price'; id = { listing_id: first(va, 'id') }; }
        else if (!vIn.live) { push({ kind: KIND.VENUE_IN, collection: col.key, token_id: token, venue: vIn.key, from, to, note: 'legacy venue escrow (trade/offer)' }); continue; }
        push(Object.assign({ kind: KIND.LIST, collection: col.key, token_id: token, venue: vIn.key, from, to, price, price_reason: reason }, id));
        continue;
      }
      if (vOut) {  // ---- out of a venue = sale, delist, or 2023 settlement
        const vw = venueW(from); const va = vw ? vw.a : {}; const vacts = vw ? actionsOf(vw) : [];
        if (vacts.includes('settle') || vacts.includes('buy_nft') || vacts.some(x => /launch-nft\/deposit_nft/.test(x)) || vacts.includes('accept_offer')) {
          let price, split = null, id = {}, seller = first(va, 'seller') || null, buyer = to;
          if (vacts.includes('settle')) { price = { amount: first(va, 'amount'), denom: denomLabel(first(va, 'denom')) }; id = { auction_id: first(va, 'auction_id') }; const out3 = legs.filter(l => l.from === from); split = out3.length ? { legs: out3 } : null; }
          else if (vacts.includes('buy_nft')) { price = { amount: first(va, 'price'), denom: (legs.find(l => l.from === from) || {}).denom || null }; id = { listing_id: first(va, 'listing_id'), accepted_offer_id: first(va, 'accepted_offer_id') || null }; split = { fee: first(va, 'fee'), royalty: first(va, 'royalty'), seller: first(va, 'seller_receives'), fee_bps: first(va, 'effective_fee_bps') }; buyer = first(va, 'buyer') || to; }
          else if (vacts.some(x => /deposit_nft/.test(x))) { const denom = (legs.find(l => l.to === from) || {}).denom || null; price = { amount: first(va, 'deposit_amount'), denom }; id = { listing_id: first(va, 'id'), done: first(va, 'launch-nft/done') }; split = { fee: first(va, 'protocol_fee_amount'), royalty: first(va, 'royalty_amount'), seller: first(va, 'seller_amount') }; seller = (legs.find(l => l.from === from && l.amount === first(va, 'seller_amount')) || {}).to || null; }
          else { price = (legs.find(l => l.from === from) || null) && { amount: legs.find(l => l.from === from).amount, denom: legs.find(l => l.from === from).denom }; id = { offer_id: first(va, 'offer_id') }; }
          push(Object.assign({ kind: KIND.SALE, collection: col.key, token_id: token, venue: vOut.key, from: seller, to: buyer, price, split, via_offer: !!(id.accepted_offer_id || id.offer_id) }, id));
        } else if (vacts.some(x => /cancel/.test(x))) {
          push({ kind: KIND.DELIST, collection: col.key, token_id: token, venue: vOut.key, from, to, listing_id: first(va, 'listing_id') || first(va, 'id') || null, auction_id: first(va, 'auction_id') || null, cancelled_by: first(va, 'cancelled_by') || null });
        } else if (!vOut.live) {
          const pay = legs.find(l => l.to === to || l.to === from) || null;
          push({ kind: pay ? KIND.SALE : KIND.VENUE_OUT, collection: col.key, token_id: token, venue: vOut.key, from, to, price: pay ? { amount: pay.amount, denom: pay.denom } : null, note: 'legacy venue settlement' });
        } else push({ kind: KIND.VENUE_OUT, collection: col.key, token_id: token, venue: vOut.key, from, to, note: 'venue release without a known verb (expiry?)' });
        continue;
      }
      if (cuIn) { push({ kind: cuIn.role === 'daodao_voting' ? KIND.STAKE : KIND.STAKE_ENTERPRISE, collection: col.key, token_id: token, from, to, custodian: cuIn.role }); continue; }
      if (cuOut) { push({ kind: cuOut.role === 'daodao_voting' ? KIND.CLAIM : KIND.UNSTAKE_ENTERPRISE, collection: col.key, token_id: token, from, to, custodian: cuOut.role }); continue; }
      if (idx.launchByAddr[from] === col.key) {   // ---- primary sale: outbound from the launchpad holder; price = payment legs / tokens out in this msg
        const outs = W.filter(x => contractOf(x) === c && (actionsOf(x).includes('transfer_nft')) && first(x.a, 'sender') === from).length || 1;
        let paid = legs.filter(l => l.from === to || l.to === from);   // buyer → holder
        if (!paid.length) paid = legs.filter(l => l.from === from);       // holder forwarding the attached funds to the proceeds wallet (PL launchpad shape)
        const total = paid.reduce((s, l) => s + Number(l.amount || 0), 0);
        push({ kind: KIND.MINT_PURCHASE, collection: col.key, token_id: token, from, to, price: paid.length ? { amount: String(Math.round(total / outs)), denom: paid[0].denom, tokens_in_tx: outs } : { amount: '0', denom: null, tokens_in_tx: outs }, price_reason: paid.length ? undefined : 'no_payment_leg_in_tx:free_or_admin_distribution' });
        continue;
      }
      if (idx.distByAddr[from] === col.key) { push({ kind: KIND.TRANSFER, collection: col.key, token_id: token, from, to, note: 'primary distribution wallet' }); continue; }
      if (isEscrow) { const co = W.find(x => contractOf(x) === c && actionsOf(x).includes('ve/change_lock_owner')); push({ kind: KIND.LOCK_TRANSFER, collection: col.key, token_id: token, from: co ? first(co.a, 'old_owner') : from, to: co ? first(co.a, 'new_owner') : to }); continue; }
      push({ kind: KIND.TRANSFER, collection: col.key, token_id: token, from, to });
    }

    // ----- custodian events with no cw721 move: DAODAO unstake (token ids only in the msg body)
    for (const w of W) {
      const c = contractOf(w); const cu = idx.custByAddr[c]; if (!cu || cu.role !== 'daodao_voting') continue;
      if (actionsOf(w).includes('unstake')) { const ids = body && body.unstake && Array.isArray(body.unstake.token_ids) ? body.unstake.token_ids : null; for (const t of (ids || [null])) push({ kind: KIND.UNSTAKE, collection: cu.collection, token_id: t, from: c, to: first(w.a, 'from'), custodian: cu.role, claim_duration: first(w.a, 'claim_duration') || null, note: t ? undefined : 'token ids live in the msg body (not archived in raw parts) — resolve at claim' }); }
    }
  }
  return out;
}

// stable key for write-once merges
function recordKey(r) { return [r.txhash, r.msg_index, r.kind, r.collection || '-', r.token_id || '-', r.offer_id || r.listing_id || r.auction_id || '-'].join('|'); }

module.exports = { KIND, classifyNftTx, buildIndex, recordKey, b64json };
// <<NFT FLOWS CLASSIFIER v1>> END
