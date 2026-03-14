# Evidence and YES Pool

## What Is the YES Pool?

When a round settles (someone guesses correctly), **15% of the prize pool** is set aside as the YES pool. This pool is distributed to players who asked public questions that received "Yes" answers from the AI.

The YES pool rewards players who contributed useful information to the round by narrowing down the hidden phrase.

## How It Works

1. A player asks a **public** question during the round
2. The AI answers **Yes** — the backend calls `record_v2_evidence` on-chain
3. The player's `V2Evidence` account is created (or updated if they already have one)
4. Their `yes_count` increments by 1, and the round's `total_yes_answers` increments by 1
5. When the round settles, the YES pool is calculated: `pool * 1500 / 10000` (15%)
6. Each eligible player can claim their proportional share

## Distribution Formula

Each player's share is proportional to their number of YES answers relative to the total:

```
player_share = evidence_pool * player_yes_count / total_yes_answers
```

## Example

A round settles with a 1 SOL pool. The YES pool is 0.15 SOL.

| Player | YES Answers | Share | Payout |
|--------|-------------|-------|--------|
| Player A | 4 | 4/7 | ~0.0857 SOL |
| Player B | 2 | 2/7 | ~0.0428 SOL |
| Player C | 1 | 1/7 | ~0.0214 SOL |
| **Total** | **7** | **7/7** | **0.15 SOL** |

More YES answers from your public questions means a bigger share of the pool.

## Edge Case: No YES Answers

If no public questions received YES answers during a round, the entire 15% YES pool is added to the rollover balance instead. Nothing is lost — the funds carry forward to increase the next round's prize pool.

## Claiming

After a round is settled, eligible players can claim their YES pool share:

- **Self-claim** — The player signs a `claim_v2_evidence` transaction directly
- **Authority release** — The backend can release evidence payouts on behalf of players

Claims are one-time. Once a player claims their share, their evidence account is marked as claimed and cannot be claimed again. The round tracks `evidence_claimed` as a running total of all claimed lamports.

## Only Public Questions Count

Private questions do not generate evidence, even if the AI answers Yes. Only **public** questions contribute to the YES pool. This creates an incentive to ask public questions — you give up information to all players, but you earn a share of 15% of the prize pool if the answer is Yes.

## BPS Constants (On-Chain)

```rust
BPS_YES_POOL: u64 = 1500;  // 15% of pool → YES evidence claimants
BPS_TOTAL: u64 = 10000;    // 100%
```

All arithmetic uses checked operations. Integer-division rounding dust is absorbed by the rollover, ensuring no lamports are lost.
