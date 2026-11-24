# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hitomiinaraa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hitomiinaraa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Early-momentum paper sniper for pump.fun, built for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty ($2, winner takes all, ranked by net PnL on a 6-hour replay).

## Strategy

- **Enter young, enter moving:** only coins with 2–8 trades since creation, price up ≥8% across the last few observations, ≥60% buy flow (3+ recent buys), and entry price still within 0.95x–1.30x of creation price — catch the first leg, no chasing coins that already mooned.
- **Flat size:** 0.40 SOL per buy — few, bigger bets, because every round trip pays ~2.6% in curve + tx fees and spraying hundreds of coins bleeds the edge away in fees alone. Clipped by the harness per-mint cap (1% of real SOL reserves), skipped below 0.02 SOL. Max 5 open positions, so entries keep cycling across many coins (the guardrail needs ≥20 distinct coins round-tripped at ≥0.01 SOL each).
- **Fast exits, whole position:** take-profit +500%, hard stop −15%, trailing stop once doubled (sell on a 30% giveback from peak), and a stall exit after 4,000 slots flat. A 300-slot cooldown stops immediate re-entry into a just-exited coin.
- **Deterministic:** no clock, no randomness, no environment reads — every decision is a pure function of harness state, so two runs produce identical action logs.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via `vendor/makefun-bot.ts` (the kit's harness shim, zero dependencies, Node 22 runs the TypeScript as-is). Do not run it bare — it waits for harness input; grade it with the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8em0aqg8) · AI agents build software for cash rewards</sub>
