# PDA Accounts

## Overview

All on-chain state is stored in Program Derived Addresses (PDAs). PDAs are deterministic -- anyone can compute the address from the seeds and program ID. This makes account verification trustless and transparent. All V2 accounts use the `v2_` prefix for namespace isolation from V1.

## Account Map

```
Program: 63TqEHi69yjvHLA1suNUFq7XUQUrPJsaTC2T52xZu5x1
│
├── V2GameState  ["v2_game_state"]
│   Global singleton. Stores authority, treasury, round counter, timer config.
│
├── V2Vault  ["v2_vault"]
│   Global singleton. Holds all deposited SOL.
│
├── V2Round  ["v2_round", round_id]
│   One per round. Stores commit hash, status, deposits, evidence tracking.
│   Round 1: ["v2_round", 0x0100000000000000]
│   Round 2: ["v2_round", 0x0200000000000000]
│   ...
│
├── V2Entry  ["v2_entry", round_id, player_pubkey]
│   One per (round, player) pair. Tracks individual entries and fees paid.
│
└── V2Evidence  ["v2_evidence", round_id, wallet_pubkey]
    One per (round, wallet) pair. Tracks YES answer counts for evidence claims.
```

## V2GameState

**Seeds:** `["v2_game_state"]`
**Size:** 137 bytes (8 discriminator + 129 data)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| `authority` | `Pubkey` | 32 | Backend wallet that controls rounds |
| `treasury` | `Pubkey` | 32 | Wallet receiving the 5% protocol fee |
| `buyback_wallet` | `Pubkey` | 32 | Wallet receiving funds on expire |
| `current_round_id` | `u64` | 8 | Counter tracking the latest round |
| `rollover_balance` | `u64` | 8 | Explicit rollover balance (lamports) |
| `round_duration_secs` | `i64` | 8 | Round duration in seconds (e.g., 1200 = 20 min) |
| `entry_cutoff_secs` | `i64` | 8 | Seconds before `ends_at` when entries close (e.g., 180 = 3 min) |
| `bump` | `u8` | 1 | PDA bump seed |

**Created by:** `initialize` (once, ever)
**Modified by:** `create_round` (increments `current_round_id`), `settle` (updates `rollover_balance`), `expire` (updates `rollover_balance`), `force_expire` (updates `rollover_balance`), `sweep_v2_evidence` (updates `rollover_balance`)

### Deriving the Address

```typescript
const [gameStatePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("v2_game_state")],
  programId
);
```

## V2Vault

**Seeds:** `["v2_vault"]`
**Size:** 9 bytes (8 discriminator + 1 data)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| `bump` | `u8` | 1 | PDA bump seed |

The Vault is a minimal account -- its purpose is to hold SOL via its lamport balance, not to store data. The Vault's lamport balance equals `V2GameState.rollover_balance + rent_exempt_minimum` plus any active-round deposits not yet settled/expired, plus any unsettled evidence pool funds.

Rollover is tracked explicitly in `V2GameState.rollover_balance`, not derived from the Vault's lamport balance. Unsolicited SOL transfers to the Vault PDA are ignored by the game math.

**Created by:** `initialize` (once, ever)
**Lamports modified by:** `enter` (increases), `settle` (decreases), `expire` (decreases), `force_expire` (decreases), `claim_v2_evidence` (decreases)

### Deriving the Address

```typescript
const [vaultPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("v2_vault")],
  programId
);
```

## V2Round

**Seeds:** `["v2_round", round_id as u64 LE bytes]`
**Size:** 298 bytes (8 discriminator + 290 data)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| `round_id` | `u64` | 8 | Sequential identifier |
| `commit_hash` | `[u8; 32]` | 32 | SHA-256(answer:salt) |
| `authority` | `Pubkey` | 32 | Round creator (must match V2GameState.authority) |
| `started_at` | `i64` | 8 | Unix timestamp when round was created |
| `ends_at` | `i64` | 8 | Unix timestamp deadline (started_at + round_duration_secs) |
| `entry_cutoff` | `i64` | 8 | Unix timestamp cutoff for entries (ends_at - entry_cutoff_secs) |
| `status` | `V2RoundStatus` | 1 | Active / Settled / Expired |
| `total_entries` | `u64` | 8 | Number of unique player entries |
| `total_deposits` | `u64` | 8 | Sum of all entry fees paid in this round |
| `rollover_in` | `u64` | 8 | SOL inherited from the previous round |
| `revealed_answer` | `String` | 4 + 64 | Plaintext answer (set on settle/expire) |
| `revealed_salt` | `String` | 4 + 64 | Plaintext salt (set on settle/expire) |
| `bump` | `u8` | 1 | PDA bump seed |
| `evidence_count` | `u64` | 8 | Unique wallets with YES answers |
| `total_yes_answers` | `u64` | 8 | Sum of yes_count across all wallets |
| `evidence_pool` | `u64` | 8 | 15% of pool held for evidence claims (set at settle) |
| `evidence_claimed` | `u64` | 8 | Running total of claimed evidence lamports |

**Status Enum:**

```rust
pub enum V2RoundStatus {
    Active,   // 0 -- Accepting entries
    Settled,  // 1 -- Winner paid, round closed
    Expired,  // 2 -- No winner, funds distributed
}
```

**Created by:** `create_round`
**Modified by:** `enter` (total_entries, total_deposits), `record_v2_evidence` (evidence_count, total_yes_answers), `settle` (status, revealed_answer, revealed_salt, evidence_pool), `expire` (status, revealed_answer, revealed_salt), `force_expire` (status), `claim_v2_evidence` (evidence_claimed), `sweep_v2_evidence` (evidence_claimed)

### Deriving the Address

```typescript
const roundIdBuffer = Buffer.alloc(8);
roundIdBuffer.writeBigUInt64LE(BigInt(roundId));

const [roundPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("v2_round"), roundIdBuffer],
  programId
);
```

## V2Entry

**Seeds:** `["v2_entry", round_id as u64 LE bytes, player_pubkey]`
**Size:** 65 bytes (8 discriminator + 57 data)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| `round_id` | `u64` | 8 | Which round this entry belongs to |
| `player` | `Pubkey` | 32 | Player who entered |
| `amount_paid` | `u64` | 8 | SOL paid as entry fee (in lamports) |
| `entered_at` | `i64` | 8 | Unix timestamp when the entry was made |
| `bump` | `u8` | 1 | PDA bump seed |

Unlike V1's Deposit which uses `init_if_needed` (allowing multiple deposits per round), the V2Entry uses `init` -- each player gets exactly one entry per round. The entry fee is determined by the escalating price schedule at the time of entry.

**Created by:** `enter`

### Deriving the Address

```typescript
const roundIdBuffer = Buffer.alloc(8);
roundIdBuffer.writeBigUInt64LE(BigInt(roundId));

const [entryPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("v2_entry"), roundIdBuffer, playerPublicKey.toBuffer()],
  programId
);
```

## V2Evidence

**Seeds:** `["v2_evidence", round_id as u64 LE bytes, wallet_pubkey]`
**Size:** 59 bytes (8 discriminator + 51 data)

| Field | Type | Size | Description |
|-------|------|------|-------------|
| `round_id` | `u64` | 8 | Which round this evidence belongs to |
| `wallet` | `Pubkey` | 32 | Wallet that asked YES questions |
| `yes_count` | `u64` | 8 | Number of public YES answers for this wallet |
| `claimed` | `bool` | 1 | Whether the evidence share has been claimed |
| `initialized` | `bool` | 1 | Needed for `init_if_needed` pattern |
| `bump` | `u8` | 1 | PDA bump seed |

The V2Evidence account uses `init_if_needed` -- it is created on the first `record_v2_evidence` call for a wallet in a round, and subsequent calls increment `yes_count` without re-initializing. The `initialized` flag distinguishes a freshly allocated (zero-filled) account from one that has been explicitly initialized.

**Created by:** `record_v2_evidence` (first YES answer for a wallet)
**Modified by:** `record_v2_evidence` (subsequent YES answers, yes_count incremented), `claim_v2_evidence` (claimed set to true)
**Closed by:** `close_v2_evidence` (recovers rent to authority)

### Deriving the Address

```typescript
const roundIdBuffer = Buffer.alloc(8);
roundIdBuffer.writeBigUInt64LE(BigInt(roundId));

const [evidencePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("v2_evidence"), roundIdBuffer, walletPublicKey.toBuffer()],
  programId
);
```

## Rent Exemption

All PDAs are rent-exempt. The `initialize` instruction funds the V2GameState and V2Vault accounts, `create_round` funds the V2Round account, `enter` funds the V2Entry account (payer is the player), and `record_v2_evidence` funds the V2Evidence account (payer is the authority). Rent-exempt minimums are handled automatically by Anchor's `init` and `init_if_needed` constraints.

Rollover is tracked explicitly in `V2GameState.rollover_balance`. At round creation, the rollover is read directly from the game state rather than computed from the vault balance:

```
round.rollover_in = game_state.rollover_balance
```

After settle, expire, or force_expire, `game_state.rollover_balance` is updated to the new residual value. After `sweep_v2_evidence`, unclaimed evidence funds are added to `rollover_balance`. This ensures the vault balance always equals `rollover_balance + rent + active_deposits + unsettled_evidence_pool`.

Every instruction that transfers lamports out of the vault performs a post-distribution rent-exempt invariant check, rejecting the transaction with `VaultInsolvent` if the vault would fall below the rent-exempt minimum.
