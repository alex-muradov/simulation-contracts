use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;

/// Minimum lamports to keep in vault for rent-exemption (~890,880 for 9-byte account).
/// Using a safe margin above the exact requirement.
pub const VAULT_RENT_MINIMUM: u64 = 897_840;

/// Transfer lamports from vault PDA (program-owned) to a recipient.
/// Ensures vault never drops below rent-exempt minimum.
pub fn transfer_from_vault<'info>(
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let vault_lamports = vault.lamports();
    require!(
        vault_lamports >= amount.checked_add(VAULT_RENT_MINIMUM).ok_or(TwoPillsError::MathOverflow)?,
        TwoPillsError::VaultInsolvent
    );
    **vault.try_borrow_mut_lamports()? -= amount;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

/// Valid deposit tiers in lamports.
pub const TIER_LOW: u64 = 10_000_000;    // 0.01 SOL
pub const TIER_MEDIUM: u64 = 30_000_000; // 0.03 SOL
pub const TIER_HIGH: u64 = 50_000_000;   // 0.05 SOL

/// Payout splits (basis points out of 10000).
pub const TREASURY_BPS: u64 = 1000;  // 10%
pub const NRR_BPS: u64 = 2000;       // 20%
// Winners get the remainder: 70%

/// Minimum NRR balance to seed a round (0.001 SOL).
pub const MIN_NRR_SEED: u64 = 1_000_000;

/// Sweep window: 7 days in seconds.
pub const SWEEP_WINDOW: i64 = 604_800;

pub fn is_valid_tier(amount: u64) -> bool {
    matches!(amount, TIER_LOW | TIER_MEDIUM | TIER_HIGH)
}
