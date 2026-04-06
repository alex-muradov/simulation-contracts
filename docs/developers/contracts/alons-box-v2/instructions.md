# Instructions Reference

## Overview

The program exposes 11 instructions. Four are authority-only round lifecycle (`create_round`, `settle`, `expire`, `record_v2_evidence`), one is permissionless with a time gate (`force_expire`), two are authority-only cleanup (`sweep_v2_evidence`, `close_v2_evidence`), two are public (`enter`, `donate`), one is dual-auth claim (`claim_v2_evidence`), and one is a one-time setup (`initialize`).

```
initialize  ──→  create_round  ──→  enter  ──→  settle
                                                  or
                                                 expire
                                                  or
                                            force_expire (24hr after ends_at)

Anytime (permissionless):  donate  (any wallet adds SOL to rollover)

During active round:  record_v2_evidence  (authority records YES answers)

After settlement:  claim_v2_evidence  /  sweep_v2_evidence  /  close_v2_evidence
```

---

## `initialize`

Sets up the global V2 game state and vault. Called once at program deployment.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `treasury` | `Pubkey` | Wallet to receive the 5% protocol fee |
| `buyback_wallet` | `Pubkey` | Wallet to receive funds on round expiry |
| `round_duration_secs` | `i64` | Round duration in seconds (e.g., 1200 = 20 min) |
| `entry_cutoff_secs` | `i64` | Seconds before `ends_at` when entries close (e.g., 180 = 3 min) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Backend wallet, becomes the game authority |
| `game_state` | Yes | No | PDA to be initialized `["v2_game_state"]` |
| `vault` | Yes | No | PDA to be initialized `["v2_vault"]` |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Initializes `V2GameState` PDA with:
   - `authority` = signer
   - `treasury` = provided treasury pubkey
   - `buyback_wallet` = provided buyback pubkey
   - `current_round_id` = 0
   - `rollover_balance` = 0
   - `round_duration_secs` = provided duration
   - `entry_cutoff_secs` = provided cutoff
2. Initializes `V2Vault` PDA (empty, holds SOL via lamport balance)
3. Emits `V2GameInitialized` event

### Errors

None specific -- will fail if PDAs already exist (can only be called once).

### Example

```typescript
await program.methods
  .initialize(
    treasuryPubkey,
    buybackPubkey,
    new BN(1200),  // 20 minutes
    new BN(180),   // 3 minutes cutoff
  )
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    vault: vaultPDA,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `create_round`

Opens a new round with a committed answer hash. Authority-only. The round timer is derived on-chain from the current clock and the game state's `round_duration_secs` and `entry_cutoff_secs`.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `round_id` | `u64` | Must equal `current_round_id + 1` |
| `commit_hash` | `[u8; 32]` | SHA-256 of `"answer:salt"` |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Must match `V2GameState.authority` |
| `game_state` | Yes | No | Global state (round counter updated) |
| `round` | Yes | No | PDA to be initialized `["v2_round", round_id]` |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates caller is the authority
2. Validates `round_id == game_state.current_round_id + 1`
3. Reads `Clock::get()?.unix_timestamp` as `now`
4. Derives `started_at = now`
5. Derives `ends_at = now + game_state.round_duration_secs`
6. Derives `entry_cutoff = ends_at - game_state.entry_cutoff_secs`
7. Reads rollover from `game_state.rollover_balance`
8. Initializes V2Round PDA with:
   - `status` = Active
   - `commit_hash` = provided hash
   - `total_entries` = 0
   - `total_deposits` = 0
   - `rollover_in` = `game_state.rollover_balance`
   - `evidence_count` = 0
   - `total_yes_answers` = 0
   - `evidence_pool` = 0
   - `evidence_claimed` = 0
9. Increments `game_state.current_round_id`
10. Emits `V2RoundCreated` event

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller is not the authority |
| 6008 | `InvalidRoundId` | round_id != current_round_id + 1 |
| 6003 | `MathOverflow` | Arithmetic overflow on timer derivation |

### Example

```typescript
const answer = "red apple";
const salt = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const commitHash = computeCommitHash(answer, salt);

await program.methods
  .createRound(new BN(1), Array.from(commitHash))
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `enter`

Enters a player into an active round. One entry per player per round. The entry fee escalates over time based on the round's elapsed duration.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `amount` | `u64` | Lamports to pay (must be >= current entry fee) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `player` | Yes | Yes | Player entering the round |
| `round` | Yes | No | Must be Active status |
| `entry` | Yes | No | PDA to be initialized `["v2_entry", round_id, player]` |
| `vault` | Yes | No | Receives the SOL |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates `round.status == Active`
2. Reads on-chain clock: `now = Clock::get()?.unix_timestamp`
3. Validates `now < round.entry_cutoff` (entry period still open)
4. Calculates expected fee: `BASE_ENTRY_FEE + (elapsed / PRICE_INTERVAL_SECS) * ENTRY_FEE_INCREMENT`
   - `BASE_ENTRY_FEE` = 0.05 SOL (50,000,000 lamports)
   - `ENTRY_FEE_INCREMENT` = 0.01 SOL (10,000,000 lamports) per interval
   - `PRICE_INTERVAL_SECS` = 120 seconds (2 minutes)
5. Validates `amount >= expected_fee` (overpayment accepted)
6. Transfers `amount` lamports from player to Vault via CPI
7. Creates V2Entry PDA with:
   - `round_id` = round's ID
   - `player` = signer
   - `amount_paid` = amount
   - `entered_at` = now
8. Updates `round.total_entries += 1`
9. Updates `round.total_deposits += amount`
10. Emits `V2EntryMade` event (includes `fee_tier`, `total_deposits`, `total_entries`)

### Entry Fee Schedule

| Time Elapsed | Fee Tier | Entry Fee |
|-------------|----------|-----------|
| 0:00 - 1:59 | 0 | 0.05 SOL |
| 2:00 - 3:59 | 1 | 0.06 SOL |
| 4:00 - 5:59 | 2 | 0.07 SOL |
| 6:00 - 7:59 | 3 | 0.08 SOL |
| ... | N | 0.05 + (N * 0.01) SOL |

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6001 | `RoundNotActive` | Round status is not Active |
| 6004 | `EntryClosed` | Current time >= `round.entry_cutoff` |
| 6005 | `InsufficientEntryFee` | Amount < calculated entry fee |
| 6003 | `MathOverflow` | Arithmetic overflow on accumulation |

### Example

```typescript
const entryAmount = new BN(0.05 * LAMPORTS_PER_SOL); // Tier 0

await program.methods
  .enter(entryAmount)
  .accounts({
    player: playerKeypair.publicKey,
    round: roundPDA,
    entry: entryPDA,
    vault: vaultPDA,
    systemProgram: SystemProgram.programId,
  })
  .signers([playerKeypair])
  .rpc();
```

---

## `donate`

Permissionless donation of any amount of SOL to the pool. Any wallet can call this at any time. Donations are added to `game_state.rollover_balance` and become part of the next round's pool. Mid-round donations are preserved through `settle`, `expire`, and `force_expire` (they are NOT split to buyback or treasury on expire).

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `amount` | `u64` | Lamports to donate (must be > 0; no upper bound) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `donor` | Yes | Yes | Any wallet -- no authority check |
| `game_state` | Yes | No | Writable -- `rollover_balance` incremented |
| `vault` | Yes | No | Receives the SOL |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates `amount > 0`
2. Transfers `amount` lamports from donor to Vault via CPI (`system_program::transfer`)
3. Increments `game_state.rollover_balance += amount`
4. Emits `V2DonationMade` event (includes `donor`, `amount`, `new_rollover_balance`)

### Donation Preservation Logic

Donations are tracked through `game_state.rollover_balance`, not in the round account. When `create_round` runs, it snapshots `rollover_balance` into `round.rollover_in`. When `settle`, `expire`, or `force_expire` runs, it computes:

```
donations_during_round = game_state.rollover_balance - round.rollover_in
new_rollover_balance = computed_rollover_out + donations_during_round
```

This means donations made between rounds are picked up as `rollover_in` for the next round, and donations made during an active round are added back to rollover after the payout math runs (preserving them across settle/expire).

### No Round Required

Unlike `enter`, `donate` does **not** take a `round` account. You can donate when no round is active -- the SOL simply sits in the vault and gets picked up as `rollover_in` when the next round is created.

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6018 | `InvalidDonation` | `amount == 0` |
| 6003 | `MathOverflow` | Arithmetic overflow on `rollover_balance` accumulation |

### Example

```typescript
// Donate 0.5 SOL to the pool (any wallet, anytime)
const donationAmount = new BN(0.5 * LAMPORTS_PER_SOL);

await program.methods
  .donate(donationAmount)
  .accounts({
    donor: donorKeypair.publicKey,
    gameState: gameStatePDA,
    vault: vaultPDA,
    systemProgram: SystemProgram.programId,
  })
  .signers([donorKeypair])
  .rpc();
```

---

## `settle`

Resolves a round with a winner. Authority-only. Reveals the answer, verifies the commit hash, and distributes payouts. If evidence exists (YES answers recorded), 15% is held in vault as the evidence pool for later claiming. If no evidence exists, the 15% is added to rollover.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `answer` | `String` | Plaintext answer (max 64 bytes) |
| `salt` | `String` | Plaintext salt (max 64 bytes) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Must match `V2GameState.authority` |
| `game_state` | Yes | No | Writable -- `rollover_balance` updated |
| `round` | Yes | No | Must be Active status |
| `vault` | Yes | No | Source of payouts |
| `winner` | Yes | No | Receives 50% of pool |
| `treasury` | Yes | No | Receives 5%, must match `V2GameState.treasury` |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates caller is the authority
2. Validates answer length <= 64 bytes
3. Validates salt length <= 64 bytes
4. Computes `SHA-256(answer:salt)` and verifies against `round.commit_hash`
5. Performs rent-exempt safety check on vault
6. Calculates pool: `round.total_deposits + round.rollover_in`
7. Validates `pool <= distributable` (vault balance minus rent-exempt minimum)
8. Calculates BPS payouts:
   - Winner: `pool * 5000 / 10000` (50%)
   - YES pool: `pool * 1500 / 10000` (15%)
   - Treasury: `pool * 500 / 10000` (5%)
   - Rollover: residual = `pool - winner - yes_pool - treasury` (~30%)
9. If `round.total_yes_answers > 0`: evidence pool = YES pool amount; rollover = residual
10. If `round.total_yes_answers == 0`: evidence pool = 0; rollover = residual + YES pool amount
11. Distributes from Vault PDA:
    - 50% to winner
    - 5% to treasury
    - (evidence pool stays in vault for later claiming)
12. Post-distribution vault rent-exempt invariant check
13. Updates `game_state.rollover_balance = final_rollover + donations_during_round`, where `donations_during_round = current rollover_balance − round.rollover_in` (preserves any mid-round donations)
14. Sets `round.status = Settled`
15. Stores `revealed_answer` and `revealed_salt`
16. Sets `round.evidence_pool` (either the 15% amount or 0)
17. Emits `V2RoundSettled` event (includes `yes_pool_amount`, `rollover_out`)

### Payout Split

| Recipient | With Evidence | Without Evidence |
|-----------|--------------|-----------------|
| Winner | 50% | 50% |
| Rollover | ~30% | ~45% |
| Evidence pool | 15% | 0% |
| Treasury | 5% | 5% |

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller is not the authority, or treasury mismatch |
| 6001 | `RoundNotActive` | Round already settled or expired |
| 6002 | `InvalidCommitHash` | SHA-256 verification failed |
| 6006 | `AnswerTooLong` | Answer exceeds 64 bytes |
| 6007 | `SaltTooLong` | Salt exceeds 64 bytes |
| 6003 | `MathOverflow` | Arithmetic overflow |
| 6012 | `VaultInsolvent` | Vault cannot cover payouts while remaining rent-exempt |

### Example

```typescript
await program.methods
  .settle("red apple", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    vault: vaultPDA,
    winner: winnerPubkey,
    treasury: treasuryPubkey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `expire`

Ends a round with no winner. Authority-only. Reveals the answer, verifies the commit hash, and distributes funds from deposits only (previous rollover preserved).

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `answer` | `String` | Plaintext answer (max 64 bytes) |
| `salt` | `String` | Plaintext salt (max 64 bytes) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Must match `V2GameState.authority` |
| `game_state` | Yes | No | Writable -- `rollover_balance` updated |
| `round` | Yes | No | Must be Active status |
| `vault` | Yes | No | Source of payouts |
| `buyback_wallet` | Yes | No | Receives 47.5% of deposits, must match `V2GameState.buyback_wallet` |
| `treasury` | Yes | No | Receives 5% of deposits, must match `V2GameState.treasury` |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates caller is the authority
2. Validates answer and salt lengths (<= 64 bytes each)
3. Computes `SHA-256(answer:salt)` and verifies against `round.commit_hash`
4. Performs rent-exempt safety check on vault
5. Reads `total_deposits` and `rollover_in` from the round
6. Distributes from Vault PDA (**based on `total_deposits` only** -- previous rollover and mid-round donations are preserved):
   - 47.5% (4750 BPS) of `total_deposits` to buyback wallet
   - 5% (500 BPS) of `total_deposits` to treasury
7. Computes residual: `rollover_added = total_deposits - buyback - treasury`
8. Updates `game_state.rollover_balance = rollover_in + rollover_added + donations_during_round`, where `donations_during_round = current rollover_balance − round.rollover_in` (preserves any mid-round donations -- they are NOT split to buyback/treasury)
9. Post-distribution vault rent-exempt invariant check
10. Sets `round.status = Expired`
11. Stores `revealed_answer` and `revealed_salt`
12. Emits `V2RoundExpired` event (includes `rollover_out`)

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller is not the authority, or treasury/buyback mismatch |
| 6001 | `RoundNotActive` | Round already settled or expired |
| 6002 | `InvalidCommitHash` | SHA-256 verification failed |
| 6006 | `AnswerTooLong` | Answer exceeds 64 bytes |
| 6007 | `SaltTooLong` | Salt exceeds 64 bytes |
| 6003 | `MathOverflow` | Arithmetic overflow |
| 6012 | `VaultInsolvent` | Vault cannot cover payouts while remaining rent-exempt |

### Example

```typescript
await program.methods
  .expire("blue chair", "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6")
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    vault: vaultPDA,
    buybackWallet: buybackPubkey,
    treasury: treasuryPubkey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `force_expire`

Permissionless dead man's switch. Anyone can call this to expire a round if the authority has been offline for 24 hours after the round's `ends_at` deadline. Uses the same payout formula as `expire` but does not reveal the answer (the answer is forfeit).

### Parameters

None.

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `caller` | Yes | Yes | Anyone -- no authority check |
| `game_state` | Yes | No | Writable -- `rollover_balance` updated |
| `round` | Yes | No | Must be Active status |
| `vault` | Yes | No | Source of payouts |
| `buyback_wallet` | Yes | No | Receives 47.5% of deposits, must match `V2GameState.buyback_wallet` |
| `treasury` | Yes | No | Receives 5% of deposits, must match `V2GameState.treasury` |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Reads `Clock::get()?.unix_timestamp`
2. Validates `clock > round.ends_at + 86400` (24-hour grace period)
3. Validates `round.status == Active`
4. Validates buyback wallet and treasury against V2GameState
5. Performs rent-exempt safety check on vault
6. Reads `total_deposits` and `rollover_in` from the round
7. Distributes from Vault PDA (**based on `total_deposits` only** -- previous rollover and mid-round donations are preserved):
   - 47.5% (4750 BPS) of `total_deposits` to buyback wallet
   - 5% (500 BPS) of `total_deposits` to treasury
8. Computes residual: `rollover_added = total_deposits - buyback - treasury`
9. Updates `game_state.rollover_balance = rollover_in + rollover_added + donations_during_round` (preserves any mid-round donations)
10. Post-distribution vault rent-exempt invariant check
11. Sets `round.status = Expired`
12. Does NOT store revealed answer/salt (answer is forfeit)
13. Emits `V2ForceExpired` event (includes `rollover_out`, `caller`)

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6001 | `RoundNotActive` | Round already settled or expired |
| 6010 | `GracePeriodNotElapsed` | Current time <= `ends_at + 24 hours` |
| 6003 | `MathOverflow` | Arithmetic overflow |
| 6012 | `VaultInsolvent` | Vault cannot cover payouts while remaining rent-exempt |

### Example

```typescript
await program.methods
  .forceExpire()
  .accounts({
    caller: anyWallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    vault: vaultPDA,
    buybackWallet: buybackPubkey,
    treasury: treasuryPubkey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `record_v2_evidence`

Records a YES answer for a wallet in an active round. Authority-only. Uses `init_if_needed` pattern -- first call for a wallet creates the V2Evidence PDA, subsequent calls increment the counter.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `round_id` | `u64` | Target round (must be Active) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Must match `V2GameState.authority` (pays rent for new PDAs) |
| `game_state` | No | No | Authority validation |
| `round` | Yes | No | Must be Active status, evidence counters updated |
| `evidence` | Yes | No | PDA `["v2_evidence", round_id, wallet]` (init_if_needed) |
| `wallet` | No | No | The wallet that asked the YES question (not a signer) |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates caller is the authority
2. Validates `round.status == Active`
3. If evidence PDA is not yet initialized:
   - Sets `evidence.round_id`, `evidence.wallet`, `evidence.yes_count = 1`
   - Sets `evidence.claimed = false`, `evidence.initialized = true`
   - Increments `round.evidence_count += 1`
4. If evidence PDA is already initialized:
   - Increments `evidence.yes_count += 1`
5. Increments `round.total_yes_answers += 1`
6. Emits `V2EvidenceRecorded` event (includes `yes_count`, `total_yes_answers`)

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller is not the authority |
| 6001 | `RoundNotActive` | Round is not active |
| 6003 | `MathOverflow` | Arithmetic overflow on counter increment |

### Example

```typescript
await program.methods
  .recordV2Evidence(new BN(1))
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
    wallet: playerPubkey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `claim_v2_evidence`

Claims a wallet's proportional share of the evidence pool after settlement. Can be called by the wallet itself (self-claim) or by the authority (release on behalf).

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `round_id` | `u64` | Target round (must be Settled) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `signer` | Yes | Yes | Either the beneficiary (self-claim) or the authority |
| `game_state` | No | No | Used for authority validation |
| `round` | Yes | No | Must be Settled status, `evidence_claimed` updated |
| `evidence` | Yes | No | PDA `["v2_evidence", round_id, beneficiary]`, must be initialized and unclaimed |
| `beneficiary` | Yes | No | The wallet receiving the payout, must match `evidence.wallet` |
| `vault` | Yes | No | Source of evidence payout |
| `system_program` | No | No | Solana System Program |

### Behavior

1. Validates signer is either the beneficiary or the authority
2. Validates `round.status == Settled`
3. Validates `evidence.initialized == true`
4. Validates `evidence.claimed == false`
5. Validates `evidence.wallet == beneficiary.key()`
6. Validates `round.total_yes_answers > 0`
7. Calculates share: `evidence_pool * yes_count / total_yes_answers`
8. Validates `share > 0`
9. Performs rent-exempt safety check on vault
10. Transfers `share` from vault to beneficiary
11. Sets `evidence.claimed = true`
12. Updates `round.evidence_claimed += share`
13. Emits `V2EvidenceClaimed` event (includes `amount`, `yes_count`)

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Signer is neither the beneficiary nor the authority |
| 6017 | `RoundNotSettled` | Round status is not Settled |
| 6013 | `EvidenceNotFound` | Evidence PDA not initialized |
| 6014 | `EvidenceAlreadyClaimed` | Evidence already claimed |
| 6015 | `NoEvidence` | `total_yes_answers == 0` |
| 6016 | `NothingToClaim` | Calculated share is 0 |
| 6003 | `MathOverflow` | Arithmetic overflow |
| 6012 | `VaultInsolvent` | Vault cannot cover payout while remaining rent-exempt |

### Example

```typescript
// Self-claim by the evidence wallet
await program.methods
  .claimV2Evidence(new BN(1))
  .accounts({
    signer: playerKeypair.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
    beneficiary: playerKeypair.publicKey,
    vault: vaultPDA,
    systemProgram: SystemProgram.programId,
  })
  .signers([playerKeypair])
  .rpc();

// Authority-initiated release
await program.methods
  .claimV2Evidence(new BN(1))
  .accounts({
    signer: authorityWallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
    beneficiary: playerPubkey,
    vault: vaultPDA,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

---

## `sweep_v2_evidence`

Sweeps unclaimed evidence funds to rollover. Authority-only. Called after the claim window has passed to recover unclaimed evidence pool funds for future rounds.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `round_id` | `u64` | Target round (must be Settled) |

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Must match `V2GameState.authority` |
| `game_state` | Yes | No | Writable -- `rollover_balance` updated |
| `round` | Yes | No | Must be Settled status, `evidence_claimed` updated |
| `vault` | Yes | No | Funds remain in vault (just re-tracked as rollover) |

### Behavior

1. Validates caller is the authority
2. Validates `round.status == Settled`
3. Calculates unclaimed: `evidence_pool - evidence_claimed`
4. Validates `unclaimed > 0`
5. Adds unclaimed to `game_state.rollover_balance` (no vault transfer -- funds are already in vault)
6. Sets `round.evidence_claimed = round.evidence_pool` (marks all as claimed)
7. Emits `V2EvidenceSwept` event (includes `unclaimed_amount`)

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller is not the authority |
| 6017 | `RoundNotSettled` | Round status is not Settled |
| 6016 | `NothingToClaim` | No unclaimed evidence remaining |
| 6003 | `MathOverflow` | Arithmetic overflow |

### Example

```typescript
await program.methods
  .sweepV2Evidence(new BN(1))
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    vault: vaultPDA,
  })
  .rpc();
```

---

## `close_v2_evidence`

Closes a V2Evidence PDA after its round has been settled or expired, recovering rent to the authority. Authority-only.

### Parameters

None.

### Accounts

| Account | Writable | Signer | Description |
|---------|----------|--------|-------------|
| `authority` | Yes | Yes | Must match `V2GameState.authority` -- receives rent |
| `game_state` | No | No | Authority validation |
| `round` | No | No | Must NOT be Active status |
| `evidence` | Yes | No | PDA to be closed (rent returned to authority) |

### Behavior

1. Validates caller is the authority
2. Validates `round.status != Active` (round must be settled or expired)
3. Validates `evidence.round_id == round.round_id`
4. Closes the V2Evidence PDA, returning rent to the authority (via Anchor `close = authority`)
5. Logs closure confirmation

### Errors

| Code | Name | Condition |
|------|------|-----------|
| 6000 | `Unauthorized` | Caller is not the authority |
| 6009 | `RoundStillActive` | Round has not been settled or expired yet |

### Example

```typescript
await program.methods
  .closeV2Evidence()
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
  })
  .rpc();
```
