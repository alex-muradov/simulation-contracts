# Rounds

Each round of Alon's Box V2 is a self-contained game session with a fixed hidden answer, an on-chain timer, and a prize pool.

## Round Start

1. The AI generates a secret two-word phrase (e.g., "red apple")
2. The backend computes `SHA-256(answer:salt)` and calls `create_round` with the hash
3. The hash is stored immutably on-chain — it cannot be changed after this point
4. The on-chain timer starts (derived from the Solana clock)
5. The pot starts at 0 SOL (or inherits rollover from the previous round)

The round duration (default: 20 minutes) and entry cutoff (default: 3 minutes before end) are derived from `V2GameState` parameters at creation time:

```
started_at   = Clock::unix_timestamp
ends_at      = started_at + round_duration_secs
entry_cutoff = ends_at - entry_cutoff_secs
```

## During the Round

### Entry Period

Players enter the round by paying an escalating entry fee. See [Entry Fees](entry-fees.md) for the full fee schedule and strategy. No new entries are accepted after the entry cutoff (3 minutes before the round ends).

### Questions and Guesses

After entering, players interact for free:

| Action | Visibility | Cooldown | Effect |
|--------|-----------|----------|--------|
| Ask a Yes/No question | Public | 20 seconds | AI answers publicly, visible to all. YES answers earn evidence |
| Ask a Yes/No question | Private | 40 seconds | AI answers privately, visible only to asker |
| Submit a guess | Public | — | If correct, round ends immediately. Visible to all |
| Submit a guess | Private | — | If correct, round ends immediately. Winner revealed after settlement |

To submit a guess, a player must have asked at least **3 questions**, with at least **2 public**.

## End Conditions

### 1. Correct Guess Submitted (Settle)

The round settles immediately. Payouts from the **full pool** (deposits + rollover):

| Recipient | Share | Source |
|-----------|-------|--------|
| Winner | 50% (5000 BPS) | Full pool |
| Rollover | ~30% (3000 BPS) | Full pool |
| YES pool | 15% (1500 BPS) | Full pool → distributed to evidence claimants |
| Treasury | 5% (500 BPS) | Full pool |

The YES pool is held in the vault and distributed to players who earned evidence (public YES answers). If no evidence exists, the 15% is added to rollover instead. See [Evidence and YES Pool](evidence-and-yes-pool.md).

### 2. Timer Expires (No Winner)

Payouts are based on **`total_deposits` only** — previous rollover is fully preserved:

| Recipient | Share | Source |
|-----------|-------|--------|
| Buyback ($SIMULATION) | 47.5% (4750 BPS) | Deposits only |
| Treasury | 5% (500 BPS) | Deposits only |
| Rollover added | ~47.5% (residual) | Deposits only |

New rollover = old rollover + rollover added.

### 3. Force Expire (Safety Valve)

If a round is not settled or expired within **24 hours** after `ends_at`, anyone can call `force_expire`. This is a permissionless safety valve — no authority signature is required. The payout math is identical to a standard expire. The answer is not revealed.

## State Machine

```
  ┌────────┐     settle()       ┌─────────┐
  │ Active │ ──────────────────→ │ Settled │
  │        │                    └─────────┘
  │        │     expire()       ┌─────────┐
  │        │ ──────────────────→ │ Expired │
  │        │                    └─────────┘
  │        │     force_expire() ┌─────────┐
  │        │ ──────────────────→ │ Expired │
  └────────┘                    └─────────┘
```

- **Active** — Accepting entries (until cutoff), questions, and guesses
- **Settled** — Winner paid, YES pool available for claims, answer revealed
- **Expired** — No winner, funds distributed/rolled over

Transitions are one-way and irreversible. Once settled or expired, a round cannot accept entries or be re-resolved.

## Rollover

Rollover is tracked explicitly in `V2GameState.rollover_balance` and creates compounding prize pools across rounds:

```
Round 1: 1.0 SOL deposits → settle → rollover ≈ 0.30 SOL (residual after winner, YES pool, treasury)
Round 2: 0.5 SOL deposits + 0.30 rollover = 0.80 SOL pool
         → expire → buyback = 0.2375, treasury = 0.025
                    rollover_added = 0.5 - 0.2375 - 0.025 = 0.2375
                    new rollover = 0.30 + 0.2375 = 0.5375 SOL
Round 3: 0.8 SOL deposits + 0.5375 rollover = 1.3375 SOL pool
```

Key properties:
- Rollover is read from `game_state.rollover_balance` at round creation
- On **settle**: rollover is the residual after paying winner, YES pool, and treasury (~30%)
- On **expire**: only current deposits are split; previous rollover is fully preserved
- Unsolicited SOL transfers to the vault are ignored by game math

## On-Chain Timer

The round timer is derived from the Solana clock at round creation and enforced on-chain:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `round_duration_secs` | 1200 (20 min) | Total round length |
| `entry_cutoff_secs` | 180 (3 min) | Entry closes this many seconds before `ends_at` |
| `EMERGENCY_GRACE_SECS` | 86400 (24 h) | Grace period before `force_expire` becomes callable |

## BPS Constants (On-Chain)

```rust
// Settle (winner found) — applied to full pool
BPS_WINNER: u64 = 5000;       // 50%
BPS_ROLLOVER: u64 = 3000;     // 30%
BPS_YES_POOL: u64 = 1500;     // 15%
BPS_TREASURY: u64 = 500;      // 5%

// Expire (no winner) — applied to total_deposits only
BPS_EXPIRE_BUYBACK: u64 = 4750;   // 47.5%
BPS_EXPIRE_ROLLOVER: u64 = 4750;  // 47.5%
BPS_EXPIRE_TREASURY: u64 = 500;   // 5%
```

All arithmetic uses checked operations. Overflow causes `MathOverflow` and no funds are transferred. Rollover is always computed as a **residual** (subtraction) to capture all integer-division rounding dust.
