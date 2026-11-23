// Selective trend rider for the btc-race-24h-20261123-0511 bounty (cbBTC/USDC, 1m bars).
//
// What the dev window showed (1,440 bars, +3.64% total, the whole gain in one
// two-hour trend in hours 3-5, then 19 hours of flat noise):
//   - a round trip costs ~46 bps (4 fee + 2 slippage + ~17 impact each way at
//     full size), while a typical 1m move is ~5 bps, so frequent trading bleeds
//     to death: the EMA-cross baseline lost -$114.83 on this window.
//   - the winning shape is therefore: wait for a real trend, ride it, then stay
//     in cash. Enter only on a confirmed 2-hour move, exit when the move fades,
//     and demand an even stronger signal before ever trading again.
//
// Rules (all tuned against an exact local replay of the harness fill model,
// then verified with grade-local):
//   - Entry (flat only): 120-bar log return > +100 bps (200 bps after any prior
//     exit), close above its 240-bar average, 12-bar EMA above 48-bar EMA.
//     Buys 95% of cash, max slippage 300 bps. No entries in the last hour.
//   - Exit (holding): 100 bps trailing stop below peak equity since entry, or
//     60-bar return below -80 bps, or 150 bps drawdown from entry equity.
//     Sells the whole position. 60-bar cooldown before any re-entry.
//   - Long only, no leverage, at most one open position, at most one order
//     per reply.
//
// Wire: speaks agent-fun/bars-replay/v1 directly on stdin/stdout
// (newline-delimited JSON: hello, batch..., done; one reply per batch echoing
// its seq). No network, no wall clock, no randomness, no files outside this
// repository: every decision comes from the bars the harness sent, so two runs
// on the same data produce the same orders.

import { createInterface } from 'node:readline';

// --- tuned constants (basis points unless noted) ---
const ENTRY_R120_BPS = 100;
const REENTRY_EXTRA_BPS = 100;
const TRAIL_BPS = 100;
const EXIT_R60_BPS = -80;
const HARD_STOP_BPS = 150;
const COOLDOWN_BARS = 60;
const BUY_NUM = 95n;
const BUY_DEN = 100n;
const MAX_SLIPPAGE_BPS = 300;
const EMA_FAST = 12;
const EMA_SLOW = 48;
const SMA_BARS = 240;
const RET_ENTRY_BARS = 120;
const RET_EXIT_BARS = 60;
const LAST_ENTRY_SEQ = 1380;

const BPS = 10000;

type Order =
  | { side: 'buy'; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

type StateName = 'flat' | 'entering' | 'holding' | 'exiting';

interface HelloMsg {
  symbols: { symbol: string; price_scale: number; qty_scale: number }[];
  capital: { quote_units: string };
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number };
  fees: { min_notional_quote_units: string };
  warmup_bars?: number;
}

interface BatchMsg {
  seq: number;
  bars: { symbol: string; c: string }[];
  account: {
    cash_quote_units: string;
    equity_quote_units: string;
    positions: { symbol: string; qty: string }[];
  };
}

let symbol = '';
let priceScale = 5;
let maxWeightBps = 10000;
let minNotional = 0n;
let warmupBars = 0;

const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;

let cash = 0n;
let equity = 0n;
let heldQty = 0n;

let state: StateName = 'flat';
let peakEquity = 0;
let entryEquity = 0;
let cooldownUntil = -1;
let exits = 0;
let orderNum = 0;
let enteredSeq = -1;
let exitedSeq = -1;

function logReturn(barsBack: number): number | null {
  const n = closes.length;
  if (n <= barsBack) return null;
  return Math.log(closes[n - 1] / closes[n - 1 - barsBack]) * BPS;
}

function sma(barsBack: number): number | null {
  const n = closes.length;
  if (n < barsBack) return null;
  let sum = 0;
  for (let i = n - barsBack; i < n; i++) sum += closes[i];
  return sum / barsBack;
}

function decide(seq: number): Order[] {
  if (seq < warmupBars) return [];
  const held = heldQty > 0n;

  if (state === 'entering') {
    if (held) {
      state = 'holding';
    } else if (seq > enteredSeq + 2) {
      state = 'flat'; // buy was rejected; try again from flat
    } else {
      return [];
    }
  }
  if (state === 'exiting') {
    if (!held) {
      state = 'flat';
    } else if (seq > exitedSeq + 2) {
      state = 'holding'; // sell was rejected; re-evaluate the exit
    } else {
      return [];
    }
    if (state !== 'holding') return [];
  }

  if (state === 'holding') {
    const eq = Number(equity);
    if (eq > peakEquity) peakEquity = eq;
    const r60 = logReturn(RET_EXIT_BARS);
    const ddPeak = (1 - eq / peakEquity) * BPS;
    const ddEntry = (1 - eq / entryEquity) * BPS;
    if (ddPeak >= TRAIL_BPS || (r60 !== null && r60 < EXIT_R60_BPS) || ddEntry >= HARD_STOP_BPS) {
      exits += 1;
      cooldownUntil = seq + COOLDOWN_BARS;
      exitedSeq = seq;
      state = 'exiting';
      return [{
        side: 'sell',
        client_id: `o${++orderNum}`,
        symbol,
        qty: heldQty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      }];
    }
    return [];
  }

  // state === 'flat'
  if (seq < cooldownUntil || seq > LAST_ENTRY_SEQ) return [];
  const r120 = logReturn(RET_ENTRY_BARS);
  const avg = sma(SMA_BARS);
  const close = closes[closes.length - 1];
  if (r120 === null || avg === null || close === undefined) return [];
  if (emaFast === null || emaSlow === null || emaFast <= emaSlow) return [];
  const need = ENTRY_R120_BPS + (exits > 0 ? REENTRY_EXTRA_BPS : 0);
  if (r120 > need && close > avg) {
    const room = (BigInt(maxWeightBps) * equity) / BigInt(BPS);
    let notional = (cash * BUY_NUM) / BUY_DEN;
    if (notional > room) notional = room;
    if (notional <= 0n || notional < minNotional) return [];
    peakEquity = Number(equity);
    entryEquity = Number(equity);
    enteredSeq = seq;
    state = 'entering';
    return [{
      side: 'buy',
      client_id: `o${++orderNum}`,
      symbol,
      notional_quote_units: notional.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    }];
  }
  return [];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { type: string };
    if (msg.type === 'hello') {
      const hello = msg as unknown as HelloMsg;
      symbol = hello.symbols[0].symbol;
      priceScale = hello.symbols[0].price_scale;
      maxWeightBps = hello.caps.max_weight_bps;
      minNotional = BigInt(hello.fees.min_notional_quote_units);
      warmupBars = hello.warmup_bars ?? 0;
      cash = BigInt(hello.capital.quote_units);
      equity = cash;
      continue;
    }
    if (msg.type === 'done') {
      break;
    }
    if (msg.type !== 'batch') continue;
    const batch = msg as unknown as BatchMsg;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar !== undefined) {
      const close = Number(bar.c) / 10 ** priceScale;
      closes.push(close);
      if (emaFast === null || emaSlow === null) {
        emaFast = close;
        emaSlow = close;
      } else {
        emaFast = close * (2 / (EMA_FAST + 1)) + emaFast * (1 - 2 / (EMA_FAST + 1));
        emaSlow = close * (2 / (EMA_SLOW + 1)) + emaSlow * (1 - 2 / (EMA_SLOW + 1));
      }
    }
    cash = BigInt(batch.account.cash_quote_units);
    equity = BigInt(batch.account.equity_quote_units);
    const pos = batch.account.positions.find((p) => p.symbol === symbol);
    heldQty = pos === undefined ? 0n : BigInt(pos.qty);
    const orders = decide(batch.seq);
    process.stdout.write(JSON.stringify({ type: 'reply', seq: batch.seq, orders }) + '\n');
  }
}

await main();
