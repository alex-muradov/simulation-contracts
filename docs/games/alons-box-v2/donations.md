# Donations

The `donate` instruction is a permissionless way to add SOL to the Alon's Box V2 prize pool. Anyone — players, spectators, sponsors, partners, or other contracts — can call it at any time, with no minimum amount and no need for an active round.

## How It Works

```
Donor wallet  ──── donate(amount) ────►  V2Vault PDA
                                            │
                                            └─→ game_state.rollover_balance += amount
```

When `donate` is called, the program:

1. Validates `amount > 0`
2. Transfers `amount` lamports from the donor wallet to the Vault via a system program CPI
3. Increments `game_state.rollover_balance` by `amount`
4. Emits a `V2DonationMade` event

That's it. There is no per-donor PDA, no round account required, and no entry token issued. Donations are fire-and-forget contributions to the protocol's prize pool.

## What Donations Get You

**Nothing directly.** Donating does not give you an entry, a guess slot, evidence credit, or any claim on the pool. It is a one-way contribution. If you want to play the game, use the `enter` instruction instead.

Donors might choose to donate to:

- Boost an active round's pot to attract more players
- Sponsor a round or tournament
- Top up the protocol's rollover balance between rounds
- Demonstrate support for the game
- Fund the next round on behalf of others

## Donation Preservation

Donations are tracked through `game_state.rollover_balance`, which is a global accumulator that survives across rounds. The behavior depends on **when** you donate:

### Donating Between Rounds

If no round is active when you donate, the SOL just sits in the vault and `rollover_balance` is incremented. When the next `create_round` runs, it snapshots `rollover_balance` into `round.rollover_in`, and your donation becomes part of the next round's pool from the very start.

### Donating During an Active Round

When a round is active, `round.rollover_in` is already locked in (it was set at `create_round` time). Your donation increases `game_state.rollover_balance` but does not retroactively change `round.rollover_in`. The contract handles this by computing:

```
donations_during_round = game_state.rollover_balance - round.rollover_in
```

at the time of `settle`, `expire`, or `force_expire`. After computing the standard payout split, the program adds `donations_during_round` back into the new `rollover_balance`. This means your mid-round donation:

- **On settle**: Is fully preserved as rollover for the next round (it does not flow to the winner, YES pool, treasury, or buyback)
- **On expire**: Is fully preserved as rollover (it does not flow to buyback or treasury — even though those are funded from current-round deposits)
- **On force expire**: Same as expire — fully preserved

This is by design: donors who put SOL into the pool mid-round expect it to remain in the prize pool, not be siphoned off by protocol fees on a failed round.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Donate with `amount = 0` | Reverts with `InvalidDonation` (error 6018) |
| Donate when no round exists | Allowed — funds added to `rollover_balance`, picked up by next round |
| Donate while round is settling/expiring | Allowed at any moment up to the settle/expire transaction landing |
| Donate after entry cutoff | Allowed — donations are not subject to the entry cutoff window |
| Donate exceeds `u64` max when added to `rollover_balance` | Reverts with `MathOverflow` (error 6003) |
| Multiple donations from the same wallet | Allowed — each donation is independent, no per-donor state |

## Example

```typescript
import { BN, web3 } from "@coral-xyz/anchor";

const donationAmount = new BN(0.5 * web3.LAMPORTS_PER_SOL);

await program.methods
  .donate(donationAmount)
  .accounts({
    donor: donorKeypair.publicKey,
    gameState: gameStatePDA,
    vault: vaultPDA,
    systemProgram: web3.SystemProgram.programId,
  })
  .signers([donorKeypair])
  .rpc();
```

## Trust Properties

- **Permissionless** — No authority signature required. Anyone with SOL and a Solana wallet can donate.
- **Atomic** — The lamport transfer and `rollover_balance` increment happen in the same transaction. If either step fails, both revert.
- **Non-refundable** — Once donated, SOL cannot be withdrawn. It will eventually flow to a winner, the YES pool, the treasury, the buyback wallet, or remain in rollover indefinitely.
- **Zero-amount rejected** — `donate(0)` reverts to prevent dust spam and accidental no-op transactions.
- **No state inflation** — Donations do not create per-donor PDAs, so there is no rent burden on donors and no on-chain footprint beyond the lamport transfer and a single `u64` increment.

## Off-Chain Tracking

Donations emit a `V2DonationMade` event:

```rust
#[event]
pub struct V2DonationMade {
    pub donor: Pubkey,
    pub amount: u64,
    pub new_rollover_balance: u64,
}
```

Indexers and front-ends can subscribe to this event to display donor leaderboards, donation feeds, or sponsor recognition. There is no on-chain query that lists all donations for a round — that history must be reconstructed from event logs.

## Related

- [Instructions Reference → `donate`](../../developers/contracts/alons-box-v2/instructions.md#donate)
- [Rounds](rounds.md) — How donations interact with the round lifecycle
- [Evidence and YES Pool](evidence-and-yes-pool.md) — Donations are completely separate from evidence
