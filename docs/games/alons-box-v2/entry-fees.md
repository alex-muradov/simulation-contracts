# Entry Fees

## Core Mechanic

Players pay a one-time entry fee to join a round. The fee escalates over time — entering early is cheap, entering late is expensive. After entry, all questions and guesses are free.

## Fee Formula

```
entry_fee = 0.05 SOL + (elapsed_2min_intervals * 0.01 SOL)
```

Where `elapsed_2min_intervals` is the number of complete 2-minute intervals since the round started (integer division).

## Fee Tiers

| Time Elapsed | Intervals | Entry Fee |
|-------------|-----------|-----------|
| 0:00 – 1:59 | 0 | 0.05 SOL |
| 2:00 – 3:59 | 1 | 0.06 SOL |
| 4:00 – 5:59 | 2 | 0.07 SOL |
| 6:00 – 7:59 | 3 | 0.08 SOL |
| 8:00 – 9:59 | 4 | 0.09 SOL |
| 10:00 – 11:59 | 5 | 0.10 SOL |
| 12:00 – 13:59 | 6 | 0.11 SOL |
| 14:00 – 15:59 | 7 | 0.12 SOL |
| 16:00 – 16:59 | 8 | 0.13 SOL |

The fee continues to escalate in 0.01 SOL increments per 2-minute interval until the entry cutoff.

## Entry Cutoff

No new entries are accepted after the **entry cutoff**, which is 3 minutes before the round ends. For a standard 20-minute round, the cutoff is at minute 17.

The cutoff time is computed on-chain when the round is created:

```
entry_cutoff = ends_at - entry_cutoff_secs
```

Any `enter` transaction submitted after the cutoff is rejected by the contract.

## After Entry

Once you have entered a round, all actions are free:

- Ask public questions — **free** (20-second cooldown between questions)
- Ask private questions — **free** (40-second cooldown between questions)
- Submit guesses — **free** (requires 3+ questions asked, at least 2 public)

## Strategic Tradeoffs

| Strategy | Cost | Information |
|----------|------|------------|
| Enter early | Cheap (0.05 SOL) | Blind — no public questions have been asked yet |
| Enter mid-round | Moderate | Some public questions visible, but still time to ask your own |
| Enter late | Expensive (up to cutoff) | Maximum public information available, least time to act |

Early entry is the cheapest way in, but you are playing with no information. Late entry gives you the benefit of every public question asked so far, but you pay a premium and have less time to submit your guess.

## On-Chain Constants

```rust
BASE_ENTRY_FEE: u64 = 50_000_000;       // 0.05 SOL in lamports
ENTRY_FEE_INCREMENT: u64 = 10_000_000;   // 0.01 SOL in lamports
PRICE_INTERVAL_SECS: i64 = 120;          // 2 minutes
```

The contract accepts overpayment (to handle clock drift at tier boundaries) but rejects underpayment. Each player can only enter a round once — the entry PDA is unique per player per round.
