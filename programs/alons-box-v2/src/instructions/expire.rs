use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::rent::Rent;
use crate::constants::{BPS_EXPIRE_BUYBACK, BPS_EXPIRE_TREASURY, BPS_TOTAL};
use crate::errors::V2Error;
use crate::events::V2RoundExpired;
use crate::state::*;
use crate::utils::transfer_from_vault;

#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
        constraint = game_state.authority == authority.key() @ V2Error::Unauthorized,
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

    /// CHECK: Buyback wallet -- receives 47.5% of deposits on no-winner rounds
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

pub fn handler(ctx: Context<Expire>, answer: String, salt: String) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.round.ends_at, V2Error::RoundStillActive);

    require!(answer.len() <= 64, V2Error::AnswerTooLong);
    require!(salt.len() <= 64, V2Error::SaltTooLong);

    // -- Verify commit hash --
    let commit_input = format!("{}:{}", answer, salt);
    let computed_hash = hash(commit_input.as_bytes());
    require!(
        computed_hash.to_bytes() == ctx.accounts.round.commit_hash,
        V2Error::InvalidCommitHash
    );

    // -- Rent-exempt safety check --
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent = Rent::get()?;
    let rent_exempt_min = rent.minimum_balance(V2Vault::SIZE - 8); // subtract discriminator

    // -- Payouts from deposits only (old rollover untouched) --
    let round = &ctx.accounts.round;
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

    // -- Update rollover --
    ctx.accounts.game_state.rollover_balance = rollover_out;

    // -- Update round state --
    let round = &mut ctx.accounts.round;
    round.status = V2RoundStatus::Expired;
    round.revealed_answer = answer;
    round.revealed_salt = salt;

    let pool = total_deposits
        .checked_add(rollover_in)
        .ok_or(V2Error::MathOverflow)?;

    emit!(V2RoundExpired {
        round_id: round.round_id,
        pool,
        buyback_amount,
        treasury_amount,
        rollover_out,
    });

    Ok(())
}
