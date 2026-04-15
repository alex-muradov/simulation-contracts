# Evidence System

## Overview

The V2 evidence system is an on-chain mechanism for distributing a portion of the prize pool to wallets that asked YES questions during a round. It replaces V1's off-chain `remaining_accounts` evidence approach with a PDA-based lifecycle that supports proportional distribution, self-claiming, and unclaimed-fund recovery.

The evidence lifecycle spans four instructions across two phases:

```
Active Round Phase:
  record_v2_evidence  (authority records YES answers, can be called multiple times)

Post-Settlement Phase:
  claim_v2_evidence   (wallet or authority claims proportional share)
  sweep_v2_evidence   (authority sweeps unclaimed funds to rollover)
  close_v2_evidence   (authority closes evidence PDA, rent → authority)
  close_v2_entry      (authority closes entry PDA, rent → player)
  close_v2_round      (authority closes round PDA, rent → authority; requires evidence resolved)
```

---

## Phase 1: Recording Evidence

### `record_v2_evidence`

Called by the authority during an active round whenever the AI determines a player's question received a YES answer. The instruction uses the `init_if_needed` pattern on the V2Evidence PDA.

**First call for a wallet:**
1. Initializes V2Evidence PDA `["v2_evidence", round_id, wallet]`
2. Sets `evidence.round_id`, `evidence.wallet`, `evidence.yes_count = 1`
3. Sets `evidence.claimed = false`, `evidence.initialized = true`
4. Increments `round.evidence_count += 1` (unique wallet counter)
5. Increments `round.total_yes_answers += 1`

**Subsequent calls for the same wallet:**
1. Increments `evidence.yes_count += 1`
2. Increments `round.total_yes_answers += 1`
3. `round.evidence_count` is NOT incremented (same wallet)

**Key design decisions:**
- The authority pays rent for evidence PDAs (payer = authority in `init_if_needed`)
- The wallet is passed as an `UncheckedAccount` (not a signer) -- only the authority can record evidence
- Evidence can only be recorded while `round.status == Active`
- The `initialized` flag distinguishes a genuinely initialized PDA from a zero-filled account allocated by `init_if_needed`

### Round-Level Counters

Two counters on V2Round track the aggregate evidence state:

| Field | Description |
|-------|-------------|
| `evidence_count` | Number of unique wallets with at least one YES answer |
| `total_yes_answers` | Sum of all `yes_count` values across all wallets |

These counters are used at settlement to determine whether to allocate the evidence pool and to calculate proportional shares.

---

## Phase 2: Settlement and Evidence Pool Allocation

When `settle` is called, the payout math branches based on `round.total_yes_answers`:

### If `total_yes_answers > 0` (evidence exists):

```
Pool = total_deposits + rollover_in

Winner:        pool * 5000 / 10000  = 50%   → transferred to winner
YES pool:      pool * 1500 / 10000  = 15%   → held in vault as evidence_pool
Treasury:      pool * 500  / 10000  = 5%    → transferred to treasury
Rollover:      pool - winner - yes_pool - treasury ≈ 30%  → tracked in game_state
```

The `round.evidence_pool` field is set to the YES pool amount. These funds remain in the vault, available for claiming.

### If `total_yes_answers == 0` (no evidence):

```
Pool = total_deposits + rollover_in

Winner:        pool * 5000 / 10000  = 50%   → transferred to winner
YES pool:      0                             → not allocated
Treasury:      pool * 500  / 10000  = 5%    → transferred to treasury
Rollover:      pool - winner - 0 - treasury ≈ 45%  → tracked in game_state
```

The `round.evidence_pool` field is set to 0. The 15% that would have gone to evidence is absorbed into rollover.

---

## Phase 3: Claiming Evidence

### `claim_v2_evidence`

After settlement, each wallet with recorded evidence can claim its proportional share. The share formula is:

```
share = evidence_pool * yes_count / total_yes_answers
```

This is integer division, so rounding is truncated (floor). The sum of all individual claims will be less than or equal to `evidence_pool`. Any rounding dust is recovered by `sweep_v2_evidence`.

**Authorization model:**
The signer must be either:
1. The beneficiary wallet (self-claim) -- the player claims their own share
2. The authority -- claims on behalf of the wallet (release model)

This dual-auth design supports two integration patterns:
- **Player-initiated:** The frontend calls `claim_v2_evidence` with the player's wallet as both signer and beneficiary
- **Backend-initiated:** The backend batch-processes claims, calling `claim_v2_evidence` with the authority as signer for each beneficiary

**Constraints enforced:**
- `round.status == Settled` (not Active, not Expired -- evidence is only distributed on settle)
- `evidence.initialized == true` (the PDA was actually written to by `record_v2_evidence`)
- `evidence.claimed == false` (prevents double-claiming)
- `evidence.wallet == beneficiary.key()` (the correct wallet receives the payout)
- `round.total_yes_answers > 0` (prevents division by zero)
- `share > 0` (prevents zero-value transfers)
- Vault remains rent-exempt after transfer

After a successful claim:
- `evidence.claimed` is set to `true`
- `round.evidence_claimed` is incremented by `share`
- `V2EvidenceClaimed` event is emitted with the `amount` and `yes_count`

---

## Phase 4: Sweeping Unclaimed Evidence

### `sweep_v2_evidence`

After the claim window has passed, the authority calls `sweep_v2_evidence` to move unclaimed evidence funds to rollover. This is a bookkeeping operation -- no SOL is transferred out of the vault.

```
unclaimed = evidence_pool - evidence_claimed
game_state.rollover_balance += unclaimed
round.evidence_claimed = round.evidence_pool  // marks all as claimed
```

**Key properties:**
- Authority-only
- Round must be Settled
- `unclaimed` must be > 0 (reverts with `NothingToClaim` if everything was already claimed or swept)
- No vault transfer occurs -- funds are already in the vault, the instruction only updates the rollover tracking in `game_state.rollover_balance`
- Once swept, the unclaimed funds become part of the prize pool for the next round

**Rounding dust handling:** Because `claim_v2_evidence` uses integer division (`evidence_pool * yes_count / total_yes_answers`), the sum of all claimed amounts may be slightly less than `evidence_pool`. The sweep captures this rounding dust and adds it to rollover, ensuring no lamports are permanently stranded.

### `close_v2_evidence`

After a round is settled or expired, the authority can close V2Evidence PDAs to recover rent. This is purely a rent recovery operation -- the evidence data is no longer needed once the round is complete.

**Constraints:**
- Authority-only
- Round must NOT be Active (must be Settled or Expired)
- `evidence.round_id == round.round_id` (ensures the evidence belongs to the specified round)
- Rent is returned to the authority via Anchor's `close = authority` constraint

---

## Backend Integration

The backend orchestrates the evidence lifecycle in the following sequence:

### During an Active Round

```
1. Player asks a question
2. AI processes the question
3. If the answer is YES:
   → Backend calls record_v2_evidence(round_id)
     with the player's wallet as the `wallet` account
4. Repeat for each YES answer
```

Multiple YES answers for the same wallet increment `yes_count`, giving that wallet a larger proportional share.

### After Settlement

```
1. Backend calls settle(...) with winner, answer, salt
   → evidence_pool is set (15% of pool if evidence exists, 0 if not)

2. For each wallet with evidence:
   → Backend calls claim_v2_evidence(round_id)
     with authority as signer and wallet as beneficiary
   → Or: wallet calls claim_v2_evidence itself

3. After claim window:
   → Backend calls sweep_v2_evidence(round_id)
     to move unclaimed funds to rollover

4. Cleanup (rent recovery):
   → Backend calls close_v2_evidence for each evidence PDA
     (rent → authority)
   → Backend calls close_v2_entry for each entry PDA
     (rent → player who entered)
   → Backend calls close_v2_round for the round PDA
     (rent → authority; must be last — requires evidence resolved)
```

### Timing Considerations

- `record_v2_evidence` must be called while the round is Active. Once the round is settled or expired, no more evidence can be recorded.
- `claim_v2_evidence` can only be called after settlement (status = Settled). It cannot be called on expired rounds -- evidence is only distributed when there is a winner.
- `sweep_v2_evidence` should be called after all expected claims have been processed. There is no on-chain time gate -- the backend controls the claim window off-chain.
- `close_v2_evidence` can be called at any time after the round is no longer Active. It is independent of claim/sweep status.

### Example: Full Evidence Lifecycle

```typescript
// 1. Record evidence during round
await program.methods
  .recordV2Evidence(new BN(roundId))
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
    wallet: playerWallet,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

// 2. Settle round (evidence_pool set automatically)
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

// 3. Claim evidence (authority-initiated)
await program.methods
  .claimV2Evidence(new BN(roundId))
  .accounts({
    signer: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
    beneficiary: playerWallet,
    vault: vaultPDA,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

// 4. Sweep unclaimed
await program.methods
  .sweepV2Evidence(new BN(roundId))
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    vault: vaultPDA,
  })
  .rpc();

// 5. Close evidence PDA (rent → authority)
await program.methods
  .closeV2Evidence()
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    evidence: evidencePDA,
  })
  .rpc();

// 6. Close entry PDA (rent → player)
await program.methods
  .closeV2Entry()
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
    entry: entryPDA,
    player: playerPubkey,
  })
  .rpc();

// 7. Close round PDA (rent → authority; must be last)
await program.methods
  .closeV2Round()
  .accounts({
    authority: wallet.publicKey,
    gameState: gameStatePDA,
    round: roundPDA,
  })
  .rpc();
```
