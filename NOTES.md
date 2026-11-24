# Revision notes — Pump.fun Paper Sprint

The entry is a single strategy file that only ever acts on what the replay
hands it. Fresh curves either find buyers in their first few dozen trades
or they quietly die, so the bot waits for that early proof: a young curve
already climbing on mostly-buy flow. It never chases a coin that has gone
flat, and it never averages down into a fade.

Every bet is the same modest size. The point of keeping size flat is that
fees eat a spray of tiny bets alive, while one oversized bet on a single
name can sink the whole run. A few dozen names, each given the same stake,
is the balance this entry strikes.

Exits are where the money is kept. A trade that runs gets a generous
ceiling and then a trailing stop that follows it up; a trade that stalls
gets cut without sentiment; a trade that falls hits a hard floor. Nothing
here reads a clock, rolls dice, or peeks at the environment, so feeding the
same market twice produces the same action log twice.

Checked 24 Nov 2026 with the kit's own local grader on the process driver:
net PnL -441,179,889 lamports (-4.41%) across 94 round trips, 187 fills.
The dev window is one small sample and this entry leans on a handful of
coins, so the number is a floor to learn from rather than a promise. The
bot ran twice under the grader and the two action logs matched.

One more thing worth recording: the entry never touches a coin twice in
the same batch once it has already queued an order for it, which keeps
the position cap honest when several signals fire on the same slot.
