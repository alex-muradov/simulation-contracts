# Alon's Box

**A trustless crypto-AI guessing game on Solana.**

Players deposit SOL into a program-owned escrow and compete to guess a secret answer. The answer is cryptographically committed before any deposits occur, ensuring provably fair outcomes through an on-chain commit-reveal scheme.

Built with [Anchor 0.31.1](https://www.anchor-lang.com/) | Deployed on [Solana Devnet](https://explorer.solana.com/address/J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa?cluster=devnet) | [Docs](https://simulation-theory.gitbook.io/simulation-theory-docs)

```
Program ID: J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa
```

---

## How It Works

```
Backend commits SHA-256(answer:salt)
        |
   Round opens  -->  Players deposit SOL  -->  Round closes
        |                                           |
        v                                           v
   On-chain hash verified  <--  Backend reveals answer + salt
        |
        v
   Payouts distributed automatically via PDA escrow
```

1. **Commit** -- The backend creates a round with `SHA-256(answer:salt)` locked on-chain
2. **Deposit** -- Players deposit SOL into a program-owned Vault PDA
3. **Reveal** -- The backend reveals the plaintext answer and salt
4. **Verify** -- The contract recomputes the hash and verifies it matches the original commit
5. **Payout** -- SOL is distributed automatically: 50% winner, up to 30% evidence, 5% treasury, ~15% rollover (residual)

No one -- not even the backend -- can change the answer after players deposit. The hash is the proof.

---

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (stable + nightly)
- [Solana CLI](https://docs.solanalabs.com/cli/install) v2.0+
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) v0.31.1
- [Node.js](https://nodejs.org/) v18+

### Build

```bash
# Build the on-chain program and generate IDL
anchor build
```

### Test

```bash
# Run all 128 tests (spins up local validator automatically)
anchor test --skip-build

# Or via npm
npm test
```

### Deploy

```bash
solana config set --url devnet
anchor build
anchor deploy --provider.cluster devnet

# If upgrading an existing deployment with schema changes,
# call migrate() once with the authority wallet:
# await program.methods.migrate().accounts({ authority, gameState, systemProgram }).rpc();
```

---

## Architecture

```
                    +------------------+
                    |   Backend (Auth) |
                    +--------+---------+
                             |
              create_round / settle / expire
                             |
                             v
+----------+    deposit    +------------------+    payout    +----------+
|  Players | ----------->  |  Vault PDA       | ----------> |  Winner  |
+----------+               |  (SOL Escrow)    |             +----------+
                           +------------------+             |  Evidence|
                                                            +----------+
                                                            |  Treasury|
                                                            +----------+

  If authority goes offline for 24+ hours after round end:

+----------+  emergency_expire  +------------------+  buyback/rollover
|  Anyone  | -----------------> |  Vault PDA       | ----------------->
+----------+                    +------------------+
```

| PDA Account | Seeds | Purpose |
|-------------|-------|---------|
| `GameState` | `["game_state"]` | Global config: authority, treasury, round counter, rollover balance |
| `Vault` | `["vault"]` | Singleton SOL escrow holding all deposits |
| `Round` | `["round", round_id]` | Per-round state: commit hash, status, deposits |
| `Deposit` | `["deposit", round_id, user]` | Per-user deposit tracking |

### GameState Layout (121 bytes)

```
8   discriminator
32  authority        Pubkey
32  treasury         Pubkey
32  buyback_wallet   Pubkey
8   current_round_id u64
1   bump             u8
8   rollover_balance u64    <- added in migrate
```

`rollover_balance` tracks the cumulative SOL rolling between rounds. It is updated by `settle` and `expire`, and read by `create_round` to seed the next round's prize pool.

---

## Instructions

The program exposes 9 instructions:

| Instruction | Access | Description |
|-------------|--------|-------------|
| `initialize` | One-time | Set up game state and vault |
| `create_round` | Authority | Open a new round with committed answer hash |
| `deposit` | Public | Deposit SOL into an active round |
| `settle` | Authority | Resolve round with a winner, verify hash, distribute payouts |
| `expire` | Authority | End round with no winner, verify hash, distribute funds |
| `emergency_expire` | **Permissionless** | Dead man's switch — expire a round 24hrs after `ends_at` if authority is offline |
| `close_deposit` | Authority | Close a Deposit PDA after round ends, recover rent |
| `close_round` | Authority | Close a Round PDA after round ends, recover rent |
| `migrate` | Authority | Realloc `game_state` for schema evolution (113 -> 121 bytes) |

See [Instructions Reference](./docs/developers/contracts/alons-box/instructions.md) for full details.

### Migration (`migrate`)

The `migrate` instruction handles schema evolution for the `GameState` PDA. It was introduced to add the `rollover_balance: u64` field, growing the account from 113 to 121 bytes.

**Why it exists:** Anchor deserializes accounts before instruction logic runs. The old 113-byte account cannot be deserialized as the new 121-byte `GameState` struct, so `migrate` uses a raw `AccountInfo` and manually verifies PDA seeds, program owner, and authority.

**What it does:**
- Transfers additional rent lamports from the authority
- Reallocs the account to 121 bytes
- Zero-fills the new bytes (`rollover_balance` defaults to 0)

**Properties:**
- Authority-only (reads authority from the old byte layout at offset 8..40)
- Idempotent -- safe to call multiple times (no-op if already at target size)
- Must be called once after deploying an upgrade that changes `GameState` layout

---

## Payout Distribution

### Settle (winner found)

| Recipient | Share | Source | Description |
|-----------|-------|--------|-------------|
| Winner | 50% | Full pool | Player who guessed correctly |
| Evidence | up to 30% | Full pool | Distributed to evidence providers |
| Treasury | 5% | Full pool | Protocol fee |
| Rollover | ~15% (residual) | Full pool | `pool - winner - evidence - treasury` |

Pool = current deposits + rollover from previous round. Rollover is computed as a **residual** (subtraction) to capture all rounding dust.

### Expire (no winner)

| Recipient | Share | Source | Description |
|-----------|-------|--------|-------------|
| Buyback Wallet | 47.5% | **Deposits only** | Token buyback mechanism |
| Treasury | 5% | **Deposits only** | Protocol fee |
| Rollover added | ~47.5% (residual) | **Deposits only** | `deposits - buyback - treasury` |

Previous rollover is **fully preserved** on expire. Only current-round deposits are split. The new rollover = old rollover + rollover added.

---

## Security

- **Commit-reveal scheme** -- Answer is SHA-256 hashed before deposits; verified on-chain at settlement
- **PDA escrow** -- SOL is held by the program, not any wallet. No one can withdraw without program logic
- **Sequential round IDs** -- Prevents round skipping or replay attacks
- **Evidence cap** -- Evidence payouts hard-capped at 30% to prevent drain attacks
- **Authority checks** -- Only the designated authority can create rounds, settle, or expire
- **Buyback wallet validation** -- `expire` validates buyback wallet against `GameState.buyback_wallet`
- **Round timer enforcement** -- `create_round` validates `ends_at` is in the future
- **Emergency dead man's switch** -- Permissionless `emergency_expire` callable 24 hours after `ends_at`, prevents permanent fund lock if authority goes offline
- **Account closing** -- `close_deposit` and `close_round` recover rent from settled/expired round PDAs
- **Overflow protection** -- All arithmetic uses `checked_add` / `checked_mul`
- **On-chain events** -- All state transitions emit events for off-chain monitoring and indexing
- **Explicit rollover tracking** -- `GameState.rollover_balance` tracks the prize pool explicitly. Unsolicited vault deposits are ignored. Expire preserves the full accumulated rollover
- **Residual rounding** -- Rollover is computed as a residual (subtraction) in both settle and expire, capturing all integer-division dust
- **128 tests** -- Core flow, rollover math, balance consistency, rounding dust, multi-round accumulation, adversarial attacks (auth, replay, payout manipulation, round ID), emergency expiry, and account closing

---

## Documentation

**[Read the full docs on GitBook](https://simulation-theory.gitbook.io/simulation-theory-docs)** | [Browse locally](./docs/SUMMARY.md)

### Protocol

- [SSE Protocol Overview](./docs/protocol/overview.md)
- [AI Systems](./docs/protocol/ai-systems.md)
- [Trust Model](./docs/protocol/trust-model.md)
- [$SIMULATION Token](./docs/token/overview.md)
- [Roadmap](./docs/resources/roadmap.md)

### Alon's Box

- [Game Overview](./docs/games/alons-box/overview.md)
- [Rounds](./docs/games/alons-box/rounds.md)
- [Actions and Economy](./docs/games/alons-box/actions-and-economy.md)

### Developers

- [Architecture](./docs/developers/architecture.md)
- [Getting Started](./docs/developers/getting-started.md)
- [Instructions Reference](./docs/developers/contracts/alons-box/instructions.md)
- [PDA Accounts](./docs/developers/contracts/alons-box/pda-accounts.md)
- [Commit-Reveal Scheme](./docs/developers/contracts/alons-box/commit-reveal.md)
- [Error Codes](./docs/developers/contracts/alons-box/error-codes.md)
- [Security Model](./docs/developers/contracts/alons-box/security-model.md)
- [Testing Guide](./docs/developers/testing.md)
- [Deployment](./docs/developers/deployment.md)
- [Backend Integration](./docs/developers/integration.md)

---

## Project Structure

```
programs/alons-box/src/
  lib.rs              -- Program entry point, 9 instructions
  state.rs            -- Account structs (GameState, Round, Deposit, Vault)
  errors.rs           -- Custom error codes (6000-6011)
  events.rs           -- On-chain event definitions
  utils.rs            -- Shared helpers (vault transfers)
  instructions/
    mod.rs            -- Module re-exports
    initialize.rs     -- Game setup
    create_round.rs   -- Round creation with commit hash
    deposit.rs        -- Player SOL deposits
    settle.rs         -- Winner resolution and payouts
    expire.rs         -- No-winner resolution and payouts
    emergency_expire.rs -- Permissionless dead man's switch
    close_deposit.rs  -- Deposit PDA rent recovery
    close_round.rs    -- Round PDA rent recovery
    migrate.rs        -- GameState schema migration (realloc)

tests/
  alons-box.ts              -- 22 tests (core flow + adversarial)
  rollover-accounting.ts    -- 106 tests (rollover math, balance consistency, rounding, multi-round, adversarial)

target/
  deploy/alons_box.so -- Compiled BPF binary
  idl/alons_box.json  -- Interface Description Language
  types/alons_box.ts  -- Generated TypeScript types
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Smart Contract | Rust + Anchor 0.31.1 |
| Runtime | Solana BPF |
| Hashing | SHA-256 (commit-reveal) |
| Testing | TypeScript + ts-mocha + Chai |
| Formatting | Prettier 2.6.2 |
| Network | Solana Devnet |

---

## License

All rights reserved.
