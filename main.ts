// Early-momentum paper sniper for pump.fun (agent-fun/replay/v2).
//
// Idea: fresh bonding curves either catch a bid within their first few dozen
// trades or they fade. This bot only buys young curves that are already
// moving up on mostly-buy flow, sizes each bet small and flat, and gets out
// fast: a fixed take-profit, a hard stop, a trailing stop once a trade is
// ahead, and a stall exit for anything that goes nowhere. No clock, no
// randomness, no environment reads: every decision is a pure function of the
// harness state, so two runs produce byte-identical action logs.
//
// Money rules (capital is 10 SOL, at most 5 open positions):
// Revision note: the flat size stays flat even when a coin looks hot,
// because one hot coin must never be allowed to eat the whole book.
//   - one flat 0.20 SOL buy per coin, clipped by the harness per-mint cap
//     (1% of real SOL reserves) and skipped when the clip leaves < 0.02 SOL
//   - at least 20 distinct coins must round-trip >= 0.01 SOL, so entries
//     keep cycling instead of camping on a handful of names
//   - every exit sells the whole position

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning

// Buy size in lamports: 0.40 SOL flat per entry. Few, bigger bets: every
// round trip pays ~2.6% in curve + tx fees, so spraying 250 coins bleeds
// the edge away in fees alone. Rank-1 style is a few dozen coins, sized up.
const BUY_LAMPORTS = 400_000_000n;
// Smallest buy worth paying the per-order tx fee for: 0.02 SOL.
const MIN_BUY_LAMPORTS = 20_000_000n;
// Very-young-coin window, in trades seen on the curve: catch the first leg,
// before the move is over. Later momentum is mostly a top.
const MIN_TRADES_TO_ENTER = 2;
const MAX_TRADES_TO_ENTER = 8;
// Entry needs price up at least 8% across the last few observations...
const MOMENTUM_NUM = 108;
const MOMENTUM_DEN = 100;
// ...on at least 60% buy flow with 3+ recent buys...
const MIN_BUY_SHARE_NUM = 60;
const MIN_BUY_SHARE_DEN = 100;
const MIN_RECENT_BUYS = 3;
// ...and the coin must not already have run away: entry price within
// 0.95x-1.30x of its creation price.
const ENTRY_LOW_NUM = 95;
const ENTRY_LOW_DEN = 100;
const ENTRY_HIGH_NUM = 130;
const ENTRY_HIGH_DEN = 100;
// How many recent trade prices / directions to remember per coin.
const PRICE_WINDOW = 6;
const FLOW_WINDOW = 12;
// Exits, as value/cost multiples in thousandths (6000 = 6.00x).
// Let runners run: a very wide take-profit, a moderate stop, and a trailing
// stop that only arms once a trade has doubled and tolerates a 30%
// giveback, so normal pullbacks do not shake out the big winners.
const TAKE_PROFIT = 6000;
const STOP_LOSS = 850;
const TRAIL_ARM = 2000;
const TRAIL_GIVEBACK_NUM = 70;
const TRAIL_GIVEBACK_DEN = 100;
// Stall: flat after this many slots, close it and recycle the slot.
const MAX_HOLD_SLOTS = 4000;
// Do not re-enter a coin right after exiting it.
const REENTRY_COOLDOWN_SLOTS = 300;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 800;

// ------------------------------------------------------------------ per-coin memory

interface CoinTrack {
  createPrice: number;
  prices: number[];
  peakPrice: number;
  recentBuys: boolean[];
  trades: number;
  lastSlot: number;
}

interface HeldInfo {
  entrySlot: number;
  peakMultiple: number; // thousandths of cost
}

const tracks = new Map<string, CoinTrack>();
const held = new Map<string, HeldInfo>();
const lastExitSlot = new Map<string, number>();

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function trackFor(mint: string, slot: number): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      createPrice: 0,
      prices: [],
      peakPrice: 0,
      recentBuys: [],
      trades: 0,
      lastSlot: slot,
    };
    tracks.set(mint, t);
  }
  t.lastSlot = slot;
  return t;
}

function noteTrade(t: CoinTrack, price: number, isBuy: boolean): void {
  if (price > 0) {
    t.prices.push(price);
    if (t.prices.length > PRICE_WINDOW) t.prices.shift();
    if (price > t.peakPrice) t.peakPrice = price;
  }
  t.recentBuys.push(isBuy);
  if (t.recentBuys.length > FLOW_WINDOW) t.recentBuys.shift();
  t.trades += 1;
}

// Drop stale, never-held coins so memory stays bounded over a 6h window.
// Insertion order makes the sweep deterministic.
function pruneStale(slot: number): void {
  if (tracks.size <= 3000) return;
  for (const [mint, t] of tracks) {
    if (tracks.size <= 3000) break;
    if (!held.has(mint) && slot - t.lastSlot > 5000) tracks.delete(mint);
  }
}

// ------------------------------------------------------------------ exits

function exitOrders(state: BotState): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
    );
    if (price <= 0) continue;
    const value = Number(pos.token_amount) * price;
    const cost = Number(pos.cost_lamports);
    if (cost <= 0 || value <= 0) continue;
    const multiple = Math.floor((value * 1000) / cost);

    let info = held.get(mint);
    if (info === undefined) {
      info = { entrySlot: state.slot, peakMultiple: multiple };
      held.set(mint, info);
    }
    if (multiple > info.peakMultiple) info.peakMultiple = multiple;

    const trailed =
      info.peakMultiple >= TRAIL_ARM &&
      multiple * TRAIL_GIVEBACK_DEN <=
        info.peakMultiple * TRAIL_GIVEBACK_NUM;
    const stalled =
      state.slot - info.entrySlot > MAX_HOLD_SLOTS && multiple < 1050;

    if (multiple >= TAKE_PROFIT || multiple <= STOP_LOSS || trailed || stalled) {
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      lastExitSlot.set(mint, state.slot);
      held.delete(mint);
    }
  }
  // Forget coins whose positions closed some other way (harness flatten,
  // curve completion) so a later re-entry gets a fresh peak.
  for (const mint of held.keys()) {
    if (!state.positions.has(mint)) held.delete(mint);
  }
  return orders;
}

// ------------------------------------------------------------------ entries

function entryOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const txFee = state.txFeeLamports();

  for (const event of batch.events) {
    if (event.event === "CreateEvent") {
      const t = trackFor(event.mint, event.slot);
      const p = priceOf(
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      );
      if (p > 0 && t.createPrice === 0) {
        t.createPrice = p;
        t.peakPrice = p;
      }
      continue;
    }
    if (event.event !== "TradeEvent") continue;
    const t = trackFor(event.mint, event.slot);
    if (t.createPrice === 0) {
      // First sight was a trade, not the create: use this price as the base.
      t.createPrice = priceOf(
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      );
      t.peakPrice = t.createPrice;
    }
    noteTrade(
      t,
      priceOf(
        BigInt(event.virtual_quote_reserves),
        BigInt(event.virtual_token_reserves),
      ),
      event.is_buy,
    );
  }

  if (state.committedPositionCount() >= state.hello.caps.max_open_positions) {
    return orders;
  }

  // Only coins that traded in this batch can newly qualify.
  const seen = new Set<string>();
  for (const event of batch.events) {
    if (event.event !== "TradeEvent") continue;
    if (seen.has(event.mint)) continue;
    seen.add(event.mint);

    if (state.positions.has(event.mint)) continue;
    if (held.has(event.mint)) continue;
    // A buy decided on an earlier batch may still be in flight (2-slot
    // latency): pending is keyed by client_id, so scan it by mint.
    let buyPending = false;
    for (const p of state.pending.values()) {
      if (p.order.side === "buy" && p.order.mint === event.mint) {
        buyPending = true;
        break;
      }
    }
    if (buyPending) continue;
    const cooled = lastExitSlot.get(event.mint);
    if (cooled !== undefined && batch.slot - cooled < REENTRY_COOLDOWN_SLOTS) {
      continue;
    }

    const curve = state.curves.get(event.mint);
    if (curve === undefined || curve.complete) continue;
    const t = tracks.get(event.mint);
    if (t === undefined) continue;
    if (t.trades < MIN_TRADES_TO_ENTER || t.trades > MAX_TRADES_TO_ENTER) {
      continue;
    }
    if (t.prices.length < 4 || t.createPrice <= 0) continue;

    const now = t.prices[t.prices.length - 1];
    const then = t.prices[0];
    if (then <= 0 || now <= 0) continue;
    // Momentum: up >= 5% across the remembered window.
    if (now * MOMENTUM_DEN < then * MOMENTUM_NUM) continue;
    // Not already run away from its creation price.
    if (now * ENTRY_LOW_DEN < t.createPrice * ENTRY_LOW_NUM) continue;
    if (now * ENTRY_HIGH_DEN > t.createPrice * ENTRY_HIGH_NUM) continue;

    // Buy flow: mostly buys, at least 3 of them, in the recent window.
    let buys = 0;
    for (const b of t.recentBuys) if (b) buys += 1;
    if (buys < MIN_RECENT_BUYS) continue;
    if (
      buys * MIN_BUY_SHARE_DEN <
      t.recentBuys.length * MIN_BUY_SHARE_NUM
    ) {
      continue;
    }

    // Size: flat 0.20 SOL clipped by the harness per-mint cap.
    const cap = state.maxBuyLamports(event.mint);
    if (cap <= 0n) continue;
    const size = BUY_LAMPORTS < cap ? BUY_LAMPORTS : cap;
    if (size < MIN_BUY_LAMPORTS) continue;
    if (state.freeCashLamports() - size < txFee * 2n) continue;
    // Respect the open-position cap, counting orders already queued.
    if (
      state.committedPositionCount() + orders.length >=
      state.hello.caps.max_open_positions
    ) {
      break;
    }

    orders.push({
      side: "buy",
      mint: event.mint,
      quote_lamports: size,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    if (
      state.committedPositionCount() + orders.length >=
      state.hello.caps.max_open_positions
    ) {
      break;
    }
  }
  return orders;
}

// ------------------------------------------------------------------ run

await runBot({
  onBatch(state, batch) {
    pruneStale(batch.slot);
    const orders: OrderInput[] = [];
    orders.push(...exitOrders(state));
    orders.push(...entryOrders(state, batch));
    return orders;
  },
});
