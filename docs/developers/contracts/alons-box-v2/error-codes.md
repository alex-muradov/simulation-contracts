# Error Codes

## Reference Table

| Code | Name | Message | Triggered By |
|------|------|---------|--------------|
| 6000 | `Unauthorized` | Unauthorized: caller is not the authority | `create_round`, `settle`, `expire`, `record_v2_evidence`, `claim_v2_evidence`, `sweep_v2_evidence`, `close_v2_evidence` |
| 6001 | `RoundNotActive` | Round is not active | `enter`, `settle`, `expire`, `force_expire`, `record_v2_evidence` |
| 6002 | `InvalidCommitHash` | Invalid commit hash: SHA-256 mismatch | `settle`, `expire` |
| 6003 | `MathOverflow` | Math overflow | `create_round`, `enter`, `settle`, `expire`, `force_expire`, `record_v2_evidence`, `claim_v2_evidence`, `sweep_v2_evidence` |
| 6004 | `EntryClosed` | Entry period has closed | `enter` |
| 6005 | `InsufficientEntryFee` | Insufficient entry fee | `enter` |
| 6006 | `AnswerTooLong` | Answer too long (max 64 bytes) | `settle`, `expire` |
| 6007 | `SaltTooLong` | Salt too long (max 64 bytes) | `settle`, `expire` |
| 6008 | `InvalidRoundId` | Invalid round ID | `create_round` |
| 6009 | `RoundStillActive` | Round is still active | `close_v2_evidence` |
| 6010 | `GracePeriodNotElapsed` | Emergency grace period has not elapsed | `force_expire` |
| 6011 | `InvalidEndTime` | Invalid end time | (reserved) |
| 6012 | `VaultInsolvent` | Vault is insolvent | `settle`, `expire`, `force_expire`, `claim_v2_evidence` |
| 6013 | `EvidenceNotFound` | Evidence PDA not found | `claim_v2_evidence` |
| 6014 | `EvidenceAlreadyClaimed` | Evidence already claimed | `claim_v2_evidence` |
| 6015 | `NoEvidence` | No evidence recorded for this round | `claim_v2_evidence` |
| 6016 | `NothingToClaim` | Nothing to claim | `claim_v2_evidence`, `sweep_v2_evidence` |
| 6017 | `RoundNotSettled` | Round not settled | `claim_v2_evidence`, `sweep_v2_evidence` |

## Detailed Descriptions

### 6000 -- Unauthorized

The transaction signer is not the designated authority stored in `V2GameState.authority`. This error also triggers when the treasury account provided to `settle` does not match `V2GameState.treasury`, when the buyback wallet provided to `expire` or `force_expire` does not match `V2GameState.buyback_wallet`, or when the `claim_v2_evidence` signer is neither the beneficiary nor the authority.

**Common causes:**
- Calling authority-only instructions from a wallet other than the authority
- Passing an incorrect treasury or buyback wallet address
- A third party attempting to claim evidence for another wallet

### 6001 -- RoundNotActive

The target round's status is not `Active`. Only active rounds accept entries, can be settled/expired, and can receive evidence recordings. Once a round transitions to `Settled` or `Expired`, it is permanently closed for these operations.

**Common causes:**
- Attempting to enter a settled or expired round
- Attempting to settle/expire a round that was already settled/expired (replay attack)
- Attempting to record evidence for a completed round

### 6002 -- InvalidCommitHash

The SHA-256 hash of the provided `answer:salt` does not match the `commit_hash` stored in the V2Round PDA. This is the core security check of the commit-reveal scheme.

**Common causes:**
- Providing the wrong answer or salt
- Typo in the answer string
- Using a different salt than what was committed

### 6003 -- MathOverflow

An arithmetic operation (`checked_add`, `checked_sub`, `checked_mul`, or `checked_div`) would overflow or underflow a `u64` or `i64`. This is a safety check rather than an expected error condition.

### 6004 -- EntryClosed

The on-chain clock time has passed `round.entry_cutoff`. The entry period closes `entry_cutoff_secs` before the round's `ends_at` deadline to prevent last-second entries.

**Common causes:**
- Attempting to enter too late in the round
- Clock drift between client and on-chain validator clock

### 6005 -- InsufficientEntryFee

The `amount` parameter is less than the current entry fee calculated from the escalating price schedule. The fee increases by 0.01 SOL every `PRICE_INTERVAL_SECS` (120 seconds).

**Common causes:**
- Sending the base fee (0.05 SOL) after the price has escalated
- Not accounting for the current fee tier when building the transaction

### 6006 -- AnswerTooLong

The `answer` string exceeds 64 bytes. The V2Round PDA allocates a fixed 64-byte buffer for the revealed answer.

### 6007 -- SaltTooLong

The `salt` string exceeds 64 bytes. The V2Round PDA allocates a fixed 64-byte buffer for the revealed salt.

### 6008 -- InvalidRoundId

The provided `round_id` does not equal `game_state.current_round_id + 1`. Rounds must be created sequentially with no gaps.

**Common causes:**
- Attempting to skip round IDs (e.g., creating round 5 when next should be 3)
- Attempting to re-create an existing round ID

### 6009 -- RoundStillActive

The target round's status is still `Active`. The `close_v2_evidence` instruction can only be called after a round has been settled or expired.

**Common causes:**
- Attempting to close an evidence PDA before the round has been resolved

### 6010 -- GracePeriodNotElapsed

The 24-hour emergency grace period has not yet elapsed. `force_expire` can only be called when the current time is more than 24 hours (`EMERGENCY_GRACE_SECS` = 86400 seconds) after the round's `ends_at` timestamp.

**Common causes:**
- Calling `force_expire` too early (before `ends_at + 86400` seconds)

### 6011 -- InvalidEndTime

The `ends_at` timestamp is not in the future. Reserved for validation in round creation. In V2, round timers are derived on-chain from `round_duration_secs`, so this error is not currently triggered by any instruction but remains in the error enum for forward compatibility.

### 6012 -- VaultInsolvent

The vault cannot cover the requested distribution while remaining rent-exempt. This is a safety invariant check performed before and after every vault transfer. The vault's lamport balance must never fall below the rent-exempt minimum for its account size.

**Common causes:**
- Unexpected vault balance discrepancy (should not occur under normal operation)
- Attempting to settle/expire when vault has been drained by an external bug

### 6013 -- EvidenceNotFound

The V2Evidence PDA's `initialized` flag is `false`. The account exists (allocated by `init_if_needed`) but has not been written to by `record_v2_evidence`.

**Common causes:**
- Attempting to claim evidence for a wallet that has no recorded YES answers

### 6014 -- EvidenceAlreadyClaimed

The V2Evidence PDA's `claimed` flag is already `true`. Each evidence PDA can only be claimed once.

**Common causes:**
- Attempting to double-claim evidence (replay attack)

### 6015 -- NoEvidence

The round's `total_yes_answers` is 0. There are no evidence records to distribute shares from.

**Common causes:**
- Attempting to claim evidence from a round where no YES answers were recorded

### 6016 -- NothingToClaim

The calculated evidence share is 0 lamports, or in `sweep_v2_evidence`, the unclaimed amount is 0.

**Common causes:**
- Evidence pool is too small relative to total_yes_answers for this wallet's share to be non-zero
- All evidence has already been claimed or swept

### 6017 -- RoundNotSettled

The round's status is not `Settled`. Evidence claims and sweeps require the round to be settled (not just expired).

**Common causes:**
- Attempting to claim evidence from an expired round (evidence is only distributed on settle)
- Attempting to sweep evidence before the round is settled

## Anchor Framework Errors

In addition to custom errors, Anchor may return its own errors for account constraint violations:

| Condition | Error |
|-----------|-------|
| PDA already initialized | `AccountAlreadyInUse` |
| Incorrect PDA seeds | `ConstraintSeeds` |
| Missing signer | `ConstraintSigner` |
| Insufficient lamports | `InsufficientFunds` |

## Error Handling in TypeScript

```typescript
import { AnchorError } from "@coral-xyz/anchor";

try {
  await program.methods.settle(...).rpc();
} catch (err) {
  if (err instanceof AnchorError) {
    console.log("Error code:", err.error.errorCode.number); // e.g., 6002
    console.log("Error name:", err.error.errorCode.code);   // e.g., "InvalidCommitHash"
    console.log("Error msg:", err.error.errorMessage);
  }
}
```
