# Simulation Theory — Smart Contracts

**On-chain programs for the [Simulation Theory](https://simulation.events) crypto-AI gaming platform on Solana.**

Two provably fair games where AI meets on-chain escrow. All deposits are held by program-owned PDAs — no one can withdraw without program logic.

Built with [Anchor 0.31.1](https://www.anchor-lang.com/) | [Solana Devnet](https://explorer.solana.com/?cluster=devnet) | [Docs](https://simulation-theory.gitbook.io/simulation-theory-docs)

---

## Games

### Alon's Box — AI Guessing Game

> Guess the secret 2-word object hidden by AI. The answer is cryptographically committed before any deposits occur.

```
Program ID: J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa
```

**How it works:**

```
Backend commits SHA-256(answer:salt)
        |
   Round opens  →  Players deposit SOL  →  Round closes
        |                                        |
        v                                        v
   On-chain hash verified  ←  Backend reveals answer + salt
        |
        v
   Payouts distributed via PDA escrow
```

1. **Commit** — Backend creates a round with `SHA-256(answer:salt)` locked on-chain
2. **Deposit** — Players deposit SOL into a program-owned Vault PDA
3. **Reveal** — Backend reveals the plaintext answer and salt
4. **Verify** — Contract recomputes the hash and verifies it matches the original commit
5. **Payout** — SOL distributed automatically: 50% winner, up to 30% evidence, 5% treasury, ~15% rollover

**Payout distribution:**

| Scenario | Winner | Evidence | Treasury | Buyback | Rollover |
|----------|--------|----------|----------|---------|----------|
| **Settled** (winner found) | 50% of pool | up to 30% | 5% | — | ~15% (residual) |
| **Expired** (no winner) | — | — | 5% of deposits | 47.5% of deposits | ~47.5% (residual) |

Pool = current deposits + rollover from previous round. Previous rollover is fully preserved on expire.

**Security:** Commit-reveal scheme, sequential round IDs, evidence cap at 30%, emergency dead man's switch (permissionless expire 24hrs after `ends_at`), overflow protection, 128 tests.

---

### Two Pills — AI-Judged Debate Game

> Pick a side, stake your argument, let the AI Judge decide. Persuade to win.

```
Program ID: 7SbPUmDW8L44k7KRbxpMo7hBh4ocpv9kszpWz5iNPJLW
```

**How it works:**

```
AI generates a dilemma with two outcomes (A vs B)
        |
   Round opens  →  Players pick sides, deposit fixed tiers, submit arguments
        |                                                          |
        v                                                          v
   AI Judge evaluates arguments every 60s  ←  Live probability updates
        |
   Round expires  →  Judging phase (10s)  →  AI picks winner
        |
        v
   Winners claim payouts via PDA escrow
```

1. **Scenario** — AI generates a debate dilemma (or picks from static pool)
2. **Deposit** — Players pick side A or B, deposit a fixed tier: 0.01 / 0.03 / 0.05 SOL
3. **Argue** — Players submit text arguments for their side
4. **Judge** — AI evaluates all arguments, picks a winner based on reasoning quality
5. **Claim** — Winners claim stake back + proportional share of losers' deposits

**Fixed deposit tiers:**

| Tier | Amount | Signal |
|------|--------|--------|
| LOW | 0.01 SOL | Low confidence |
| MEDIUM | 0.03 SOL | Moderate confidence |
| HIGH | 0.05 SOL | High confidence |

**Payout distribution (from loser deposits only):**

| Recipient | Share | Description |
|-----------|-------|-------------|
| Winners | 70% | Proportional to stake |
| NRR (Next Round Reserve) | 20% | Seeds future round pools |
| Treasury | 10% | Protocol fee |

Winners receive: full stake back + proportional share of the 70% winners pool. Seeds from NRR are allocated 50/50 to both sides at round creation.

**Security:** Side-locked deposits, 255 max deposits per player per round, 7-day sweep window for unclaimed winnings, vault insolvency checks, authority transfer, 160 tests.

---

## Architecture

Both programs follow the same PDA escrow pattern:

```
                     ┌──────────────────┐
                     │  Backend (Auth)  │
                     └────────┬─────────┘
                              │
               create_round / settle / expire
                              │
                              v
┌──────────┐    deposit    ┌──────────────────┐    payout    ┌──────────┐
│  Players │ ───────────>  │    Vault PDA     │ ──────────> │  Winners │
└──────────┘               │  (SOL Escrow)    │             └──────────┘
                           └──────────────────┘             ┌──────────┐
                                                            │  Treasury│
                                                            └──────────┘
```

### PDA Accounts

**Alon's Box:**

| PDA | Seeds | Purpose |
|-----|-------|---------|
| GameState | `["game_state"]` | Global config, round counter, rollover balance |
| Vault | `["vault"]` | SOL escrow |
| Round | `["round", round_id]` | Per-round: commit hash, status, deposits |
| Deposit | `["deposit", round_id, user]` | Per-user deposit tracking |

**Two Pills:**

| PDA | Seeds | Purpose |
|-----|-------|---------|
| PillsGameState | `["pills_state"]` | Global config, round counter, NRR balance |
| PillsVault | `["pills_vault"]` | SOL escrow |
| PillsRound | `["pills_round", round_id]` | Per-round: pools, players, seeds, winner |
| PlayerPosition | `["position", round_id, user]` | Per-player: side, deposits, claimed flag |

### Instructions

**Alon's Box (9 instructions):**

| Instruction | Access | Description |
|-------------|--------|-------------|
| `initialize` | One-time | Set up game state and vault |
| `create_round` | Authority | Open round with committed answer hash |
| `deposit` | Public | Deposit SOL into active round |
| `settle` | Authority | Resolve with winner, verify hash, distribute payouts |
| `expire` | Authority | End round with no winner, distribute funds |
| `emergency_expire` | **Permissionless** | Dead man's switch — 24hrs after `ends_at` |
| `close_deposit` | Authority | Close Deposit PDA, recover rent |
| `close_round` | Authority | Close Round PDA, recover rent |
| `migrate` | Authority | Realloc GameState for schema evolution |

**Two Pills (9 instructions):**

| Instruction | Access | Description |
|-------------|--------|-------------|
| `initialize` | One-time | Set up game state and vault |
| `create_round` | Authority | Open round with `ends_at`, allocate NRR seeds |
| `deposit` | Public | Pick side (A/B), deposit fixed tier amount |
| `settle` | Authority | Resolve with winner, calculate payouts |
| `claim` | Player/Authority | Winners claim payout |
| `expire` | Authority | Expire empty rounds, return seeds to NRR |
| `sweep_unclaimed` | Authority | After 7 days, sweep unclaimed → NRR |
| `transfer_authority` | Authority | Transfer authority to new owner |
| `close_position` | Authority | Close PlayerPosition PDA, recover rent |

---

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Solana CLI](https://docs.solanalabs.com/cli/install) v2.0+
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) v0.31.1
- [Node.js](https://nodejs.org/) v18+

### Build

```bash
anchor build
```

### Test

```bash
# Run all tests (288 total — spins up local validator automatically)
anchor test

# Alon's Box only (128 tests)
anchor test -- --grep "Alon"

# Two Pills only (160 tests)
anchor test -- --grep "Pills"
```

### Deploy

```bash
solana config set --url devnet
anchor build
anchor deploy --provider.cluster devnet
```

Deployment is automated via GitHub Actions — push to `master` triggers selective deploy (only changed programs are redeployed).

---

## Project Structure

```
programs/
  alons-box/src/
    lib.rs                -- Entry point, 9 instructions
    state.rs              -- GameState, Round, Deposit, Vault
    errors.rs             -- Error codes (6000-6011)
    events.rs             -- On-chain events
    utils.rs              -- Vault transfer helpers
    instructions/         -- 9 instruction handlers

  two-pills/src/
    lib.rs                -- Entry point, 9 instructions
    state.rs              -- PillsGameState, PillsRound, PlayerPosition, PillsVault
    errors.rs             -- Error codes
    events.rs             -- On-chain events
    utils.rs              -- Tier validation, vault helpers
    instructions/         -- 9 instruction handlers

tests/
  alons-box.ts            -- 22 core flow + adversarial tests
  rollover-accounting.ts  -- 106 rollover math + balance tests
  two-pills.ts            -- 160 lifecycle, tokenomics, edge case tests

docs/                     -- GitBook documentation source
```

---

## CI/CD

| Workflow | Trigger | Action |
|----------|---------|--------|
| **Build** | Pull request → main/master | `anchor build` — verify compilation |
| **Deploy** | Push to master | Detect changed programs, deploy only modified ones to devnet |

---

## Deployed Addresses (Devnet)

| | Address |
|---|---------|
| **Alon's Box Program** | `J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa` |
| **Two Pills Program** | `7SbPUmDW8L44k7KRbxpMo7hBh4ocpv9kszpWz5iNPJLW` |
| **Alon's Box GameState** | `4bLyozSNXeBtwkdZ2JQVB45JK4qcDeMEnXcPGmBBq9mW` |
| **Alon's Box Vault** | `Ety7XRpHcqY3YyrQhdM44CAeJA9Cagym5C96CxVTZXjq` |
| **Two Pills GameState** | `6siLGWfhzQ6NMy6J5JgmhFDYUnQjE4d16cGLySfiYNw5` |
| **Two Pills Vault** | `DFgwoBdzz6AseFd21bY78NZpZykXf9QTZoK9g2fo41at` |
| **Treasury** | `GHHJDnccPpkGjP7WkAHZrNwVyAuBP3oHKM9JzAugpY8x` |

---

## Documentation

**[Full docs on GitBook](https://simulation-theory.gitbook.io/simulation-theory-docs)**

- [Protocol Overview](./docs/protocol/overview.md) · [AI Systems](./docs/protocol/ai-systems.md) · [Trust Model](./docs/protocol/trust-model.md) · [Fee Structure](./docs/protocol/fee-structure.md)
- [Alon's Box](./docs/games/alons-box/overview.md) · [Rounds](./docs/games/alons-box/rounds.md) · [Economy](./docs/games/alons-box/actions-and-economy.md)
- [Architecture](./docs/developers/architecture.md) · [Getting Started](./docs/developers/getting-started.md) · [Instructions](./docs/developers/contracts/alons-box/instructions.md) · [Security](./docs/developers/contracts/alons-box/security-model.md)
- [$SIMULATION Token](./docs/token/overview.md) · [Roadmap](./docs/resources/roadmap.md)

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Smart Contracts | Rust + Anchor 0.31.1 |
| Runtime | Solana BPF |
| Hashing | SHA-256 (commit-reveal for Alon's Box) |
| Testing | TypeScript + ts-mocha + Chai (288 tests) |
| CI/CD | GitHub Actions |
| Network | Solana Devnet |

---

## License

All rights reserved.
