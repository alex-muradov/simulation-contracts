use anchor_lang::prelude::*;
use anchor_lang::solana_program::rent::Rent;
use crate::constants::{BPS_EXPIRE_BUYBACK, BPS_EXPIRE_TREASURY, BPS_TOTAL, EMERGENCY_GRACE_SECS};
use crate::errors::V2Error;
use crate::events::V2ForceExpired;
use crate::state::*;
use crate::utils::transfer_from_vault;

#[derive(Accounts)]
pub struct ForceExpire<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
        // NOTE: No authority constraint -- anyone can call after grace period
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        mut,
        seeds = [b"v2_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == V2RoundStatus::Active @ V2Error::RoundNotActive,
    )]
    pub round: Account<'info, V2Round>,

    #[account(
        mut,
        seeds = [b"v2_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, V2Vault>,

    /// CHECK: Buyback wallet -- receives 47.5% on force expire
    #[account(
        mut,
        constraint = buyback_wallet.key() == game_state.buyback_wallet @ V2Error::Unauthorized,
    )]
    pub buyback_wallet: AccountInfo<'info>,

    /// CHECK: Treasury -- receives 5% of deposits
    #[account(
        mut,
        constraint = treasury.key() == game_state.treasury @ V2Error::Unauthorized,
    )]
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ForceExpire>) -> Result<()> {
    // -- Check grace period: only callable 24h after round ends_at --
    let clock = Clock::get()?;
    let round = &ctx.accounts.round;

    let grace_deadline = round
        .ends_at
        .checked_add(EMERGENCY_GRACE_SECS)
        .ok_or(V2Error::MathOverflow)?;
    require!(
        clock.unix_timestamp > grace_deadline,
        V2Error::GracePeriodNotElapsed
    );

    // -- Rent-exempt safety check --
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent = Rent::get()?;
    let rent_exempt_min = rent.minimum_balance(V2Vault::SIZE - 8); // subtract discriminator

    // -- Payouts from deposits only (old rollover untouched) --
    let total_deposits = round.total_deposits;
    let rollover_in = round.rollover_in;

    // 47.5% buyback (4750 BPS) -- from deposits only
    let buyback_amount = total_deposits
        .checked_mul(BPS_EXPIRE_BUYBACK)
        .ok_or(V2Error::MathOverflow)?
        .checked_div(BPS_TOTAL)
        .ok_or(V2Error::MathOverflow)?;

    // 5% treasury (500 BPS) -- from deposits only
    let treasury_amount = total_deposits
        .checked_mul(BPS_EXPIRE_TREASURY)
        .ok_or(V2Error::MathOverflow)?
        .checked_div(BPS_TOTAL)
        .ok_or(V2Error::MathOverflow)?;

    // Residual absorbs rounding dust into rollover
    let rollover_added = total_deposits
        .checked_sub(buyback_amount)
        .ok_or(V2Error::MathOverflow)?
        .checked_sub(treasury_amount)
        .ok_or(V2Error::MathOverflow)?;

    let rollover_out = rollover_in
        .checked_add(rollover_added)
        .ok_or(V2Error::MathOverflow)?;

    // -- Verify distributable: buyback + treasury leaves the vault, rollover stays --
    let outgoing = buyback_amount
        .checked_add(treasury_amount)
        .ok_or(V2Error::MathOverflow)?;
    let vault_balance = vault_info.lamports();
    let post_balance = vault_balance
        .checked_sub(outgoing)
        .ok_or(V2Error::VaultInsolvent)?;
    require!(post_balance >= rent_exempt_min, V2Error::VaultInsolvent);

    // -- Distribute from vault --

    // Buyback wallet (47.5% of deposits)
    transfer_from_vault(&vault_info, &ctx.accounts.buyback_wallet, buyback_amount)?;

    // Treasury (5% of deposits)
    transfer_from_vault(&vault_info, &ctx.accounts.treasury, treasury_amount)?;

    // -- Post-distribution invariant check --
    require!(
        vault_info.lamports() >= rent_exempt_min,
        V2Error::VaultInsolvent
    );

    // -- Update rollover (preserve any donations made during this round) --
    // saturating_sub: if a prior round's settlement reduced rollover_balance
    // below this round's rollover_in, treat donations as 0 rather than panic
    let donations_during_round = ctx.accounts.game_state.rollover_balance
        .saturating_sub(rollover_in);
    ctx.accounts.game_state.rollover_balance = rollover_out
        .checked_add(donations_during_round)
        .ok_or(V2Error::MathOverflow)?;

    // -- Update round state (no answer reveal -- answer is forfeit in emergency) --
    let round = &mut ctx.accounts.round;
    round.status = V2RoundStatus::Expired;

    let pool = total_deposits
        .checked_add(rollover_in)
        .ok_or(V2Error::MathOverflow)?;

    emit!(V2ForceExpired {
        round_id: round.round_id,
        pool,
        buyback_amount,
        treasury_amount,
        rollover_out,
        caller: ctx.accounts.caller.key(),
    });

    Ok(())
}
