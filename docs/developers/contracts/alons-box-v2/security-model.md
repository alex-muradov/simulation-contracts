# Security Model

## Threat Model

Alon's Box V2 assumes the following adversaries:

| Actor | Threat | Mitigation |
|-------|--------|------------|
| Malicious player | Drain vault, manipulate payouts, enter at wrong fee | PDA escrow, BPS caps, escalating fee validation, entry cutoff |
| Compromised backend | Change answer after entries | Commit-reveal (SHA-256 immutable on-chain) |
| External attacker | Call authority-only instructions | Signer validation against V2GameState.authority |
| Replay attacker | Re-settle/re-expire a closed round, double-claim evidence | Round status checks (Active/Settled required), `evidence.claimed` flag |

## Security Guarantees

### 1. Commit-Reveal Integrity

**Guarantee:** The answer cannot be changed after players enter.

The commit hash (`SHA-256(answer:salt)`) is stored in the V2Round PDA at creation time, before any `enter` instruction is possible. At settlement or expiry, the contract independently recomputes the hash from the revealed answer and salt, and rejects mismatches with `InvalidCommitHash`.

The backend knows the answer during the round, but cannot profit from this knowledge -- it does not participate as a player, and the payout recipients are specified in the settle instruction accounts.

### 2. Trustless Escrow

**Guarantee:** No wallet has custody of player funds. Only the program controls the Vault.

All SOL is held in the V2Vault PDA, which is owned by the program. The Vault has no private key -- it can only sign via Anchor's `seeds` constraint. Fund transfers out of the Vault can only occur through:
- `settle` -- distributes according to the fixed BPS formula (50/~30/15/5)
- `expire` / `force_expire` -- distributes according to the fixed BPS formula (47.5/47.5/5)
- `claim_v2_evidence` -- distributes proportional share from the evidence pool

There is no instruction that allows arbitrary withdrawal from the Vault.

### 3. Authority Isolation

**Guarantee:** Only the designated authority can manage rounds and evidence.

The authority is set once in `initialize` and stored in `V2GameState`. Every `create_round`, `settle`, `expire`, `record_v2_evidence`, `sweep_v2_evidence`, and `close_v2_evidence` instruction validates the signer against `game_state.authority`. An attacker with a different keypair cannot:
- Create rounds
- Settle rounds (directing payouts to themselves)
- Expire rounds
- Record evidence
- Sweep unclaimed evidence to rollover
- Close evidence PDAs

### 4. Sequential Round Enforcement

**Guarantee:** Rounds cannot be skipped, duplicated, or replayed.

The contract enforces `round_id == current_round_id + 1`. This prevents:
- **Skipping:** Creating round 99 to manipulate rollover amounts
- **Duplicating:** Re-creating an existing round (PDA already exists, Anchor rejects)
- **Replaying:** Settling or expiring a round that is already Settled/Expired (status check)

### 5. Entry Fee Validation

**Guarantee:** Players must pay at least the current entry fee.

The entry fee is calculated on-chain using the escalating price schedule: `BASE_ENTRY_FEE + (elapsed / PRICE_INTERVAL_SECS) * ENTRY_FEE_INCREMENT`. The contract validates `amount >= expected_fee`, rejecting underpayments with `InsufficientEntryFee`.

Overpayment is explicitly accepted. This is a deliberate design choice to handle tier-boundary clock drift -- if a player's transaction lands in the next tier between building and confirming, the overpayment prevents a spurious rejection. The full amount paid is deposited into the vault and counted in `total_deposits`.

### 6. Entry Cutoff Enforcement

**Guarantee:** Players cannot enter after the entry cutoff.

The on-chain clock is checked against `round.entry_cutoff` (which equals `ends_at - entry_cutoff_secs`). Entries after the cutoff are rejected with `EntryClosed`. This prevents last-second entries that could exploit knowledge of the round outcome.

### 7. Evidence Cap

**Guarantee:** Evidence payouts cannot exceed 15% of the pool.

The evidence pool is calculated as a fixed BPS percentage (`BPS_YES_POOL = 1500`) of the total pool at settlement time. Individual claims are proportional: `evidence_pool * yes_count / total_yes_answers`. The sum of all claims can never exceed `evidence_pool` because:
- Each wallet can only claim once (`evidence.claimed` flag)
- The share formula guarantees `sum(all_shares) <= evidence_pool` (integer division ensures no over-distribution)
- Rounding dust (the difference between `evidence_pool` and the sum of all individual claims) is swept to rollover by `sweep_v2_evidence`

### 8. Rent-Exempt Safety

**Guarantee:** The vault can never be drained below rent-exempt minimum.

Every instruction that transfers lamports out of the vault (`settle`, `expire`, `force_expire`, `claim_v2_evidence`) performs:
1. A pre-distribution check: `pool <= distributable` (vault balance minus rent-exempt minimum)
2. A post-distribution invariant check: `vault_info.lamports() >= rent_exempt_min`

If either check fails, the transaction reverts with `VaultInsolvent`. The rent-exempt minimum is computed dynamically from `Rent::get()` for the vault's data size (V2Vault::SIZE - 8 for the discriminator).

### 9. Force Expire Safety Valve

**Guarantee:** Player funds cannot be permanently locked if the authority goes offline.

The `force_expire` instruction is permissionless -- any wallet can call it. It is time-gated: it can only execute when the current clock time exceeds `round.ends_at + EMERGENCY_GRACE_SECS` (24 hours after the round deadline). This prevents griefing while ensuring players can recover funds if the backend disappears.

The 24-hour grace period gives the authority ample time to settle or expire the round normally. After that, anyone can trigger force expiry, which distributes funds using the standard expire formula (47.5% buyback, 5% treasury from deposits only; previous rollover preserved).

Note: `force_expire` does not reveal the answer -- the answer is forfeit in emergency scenarios.

### 10. Namespace Isolation

**Guarantee:** V2 accounts cannot collide with V1 accounts.

All V2 PDA seeds use the `v2_` prefix: `v2_game_state`, `v2_vault`, `v2_round`, `v2_entry`, `v2_evidence`. This ensures that V1 and V2 programs can coexist on the same Solana cluster without PDA address collisions, even if deployed under the same program ID. No V2 instruction can accidentally read or write V1 state.

### 11. Evidence System Security

**Guarantee:** Evidence distribution is fair and cannot be exploited.

The evidence system has several security layers:

- **Authority-only recording:** Only the authority can call `record_v2_evidence`, preventing players from self-reporting YES answers
- **Active round only:** Evidence can only be recorded during an active round, preventing post-settlement manipulation
- **Proportional distribution:** Each wallet's share is `evidence_pool * yes_count / total_yes_answers`, ensuring payouts are proportional to recorded activity
- **Single claim:** The `evidence.claimed` flag prevents double-claiming
- **Sweep safety:** `sweep_v2_evidence` moves unclaimed evidence to rollover without any vault transfer -- funds already reside in the vault, only the tracking changes in `game_state.rollover_balance`
- **Dual authorization for claims:** `claim_v2_evidence` accepts either the beneficiary wallet (self-claim) or the authority as signer, allowing both player-initiated and backend-initiated claim flows

### 12. Treasury and Buyback Validation

**Guarantee:** The treasury and buyback recipients cannot be substituted.

The `settle` instruction validates that the provided treasury account matches `game_state.treasury`. The `expire` and `force_expire` instructions validate both `treasury` and `buyback_wallet` against their stored values in V2GameState. An attacker cannot redirect protocol fees or buyback funds to their own wallet.

### 13. Overflow Protection

**Guarantee:** Arithmetic cannot silently overflow.

All arithmetic operations use Rust's `checked_add`, `checked_sub`, `checked_mul`, and `checked_div`, returning `MathOverflow` error on overflow instead of wrapping. The workspace `Cargo.toml` also enables `overflow-checks = true` for release builds.

### 14. Residual Rounding

**Guarantee:** No lamports are lost to integer-division rounding.

Rollover is always computed as a residual (subtraction) rather than an independent BPS calculation:
- **Settle:** `rollover = pool - winner - yes_pool - treasury`
- **Expire:** `rollover_added = deposits - buyback - treasury`

This guarantees that all rounding dust is captured in rollover, keeping the vault balance exactly consistent with tracked state.

### 15. On-Chain Event Monitoring

**Guarantee:** All state transitions are observable off-chain.

Every state-mutating instruction emits a structured event (`V2GameInitialized`, `V2RoundCreated`, `V2EntryMade`, `V2DonationMade`, `V2RoundSettled`, `V2RoundExpired`, `V2ForceExpired`, `V2EvidenceRecorded`, `V2EvidenceClaimed`, `V2EvidenceSwept`). Settlement and expiry events include `rollover_out` for tracking the rollover balance. These events enable:
- Real-time monitoring of game activity
- Detection of anomalous behavior (e.g., unexpected force expires)
- Historical audit trail indexed via Solana event parsers

### 16. Permissionless Donations

**Guarantee:** Donations are atomic, non-refundable, and cannot be exploited to drain or destabilize the vault.

The `donate` instruction lets any wallet add SOL to the prize pool. It is a one-way contribution -- once donated, SOL cannot be withdrawn or refunded. Security properties:

- **Atomic accounting:** The lamport transfer to the vault and the `rollover_balance` increment occur in the same transaction. There is no path where the vault grows without `rollover_balance` growing by the same amount.
- **Zero-amount rejected:** `donate(0)` reverts with `InvalidDonation`, preventing dust spam.
- **Overflow safe:** `rollover_balance` increment uses `checked_add`, reverting with `MathOverflow` if it would exceed `u64::MAX`.
- **No round dependency:** Donations work whether or not a round is active. There is no race condition with `create_round`, `settle`, or `expire`.
- **Mid-round preservation:** Donations made during an active round are preserved through settle/expire. The contract computes `donations_during_round = current rollover_balance − round.rollover_in` and adds it back to the new `rollover_balance` after the standard payout split, ensuring donations cannot be silently absorbed by buyback or treasury.
- **No state inflation:** Donations create no per-donor PDAs, no rent burden, and no on-chain footprint beyond the lamport transfer and a single `u64` increment.
- **No privilege:** Donating does not grant entry, evidence credit, voting rights, or any claim on the pool. It is a pure contribution.

The threat model considered for donations:

| Attack | Mitigation |
|--------|------------|
| Donate then drain via `force_expire` | Donations are excluded from the buyback/treasury split on expire and force_expire — they always flow to rollover |
| Donate to inflate vault, then attempt to over-claim evidence | Evidence shares are computed from `evidence_pool` (a fixed BPS of `pool` set at settle time), not from raw vault balance |
| Spam tiny donations to bloat events | No per-donation PDA is created, so there is no state cost. Off-chain indexers may apply their own filtering. |
| Donate via system transfer (bypass `donate`) | Unsolicited transfers to the vault are ignored by game math — only `donate` increments `rollover_balance` |

## What the Contract Does NOT Protect Against

- **Round timing manipulation:** The backend controls when to call `settle` or `expire` within the round's lifetime. The on-chain timer defines `ends_at` and `entry_cutoff`, and `force_expire` enables emergency recovery, but the backend can settle a round at any time before the deadline (by design -- a correct guess can end a round early).
- **Answer quality:** The commit-reveal scheme proves the answer was fixed before entries, but not that it was fair or meaningful.
- **Evidence quality:** The authority controls which wallets get evidence recorded. The contract enforces proportional distribution of the evidence pool but does not validate whether the recorded YES answers are legitimate.

These are addressed in the roadmap through TEE (Trusted Execution Environment) integration, which adds hardware-attested guarantees to AI answer generation.
