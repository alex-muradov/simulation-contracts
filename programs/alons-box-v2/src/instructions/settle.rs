use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::rent::Rent;
use crate::constants::{BPS_WINNER, BPS_YES_POOL, BPS_TREASURY, BPS_TOTAL};
use crate::errors::V2Error;
use crate::events::V2RoundSettled;
use crate::state::*;
use crate::utils::transfer_from_vault;

#[derive(Accounts)]
pub struct Settle<'info> {
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

    /// CHECK: Winner wallet -- receives 50% of pool
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: Treasury -- receives 5% of pool
    #[account(
        mut,
        constraint = treasury.key() == game_state.treasury @ V2Error::Unauthorized,
    )]
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Settle>, answer: String, salt: String) -> Result<()> {
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

    // -- Rent-exempt safety check (CNTR-12) --
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent = Rent::get()?;
    let rent_exempt_min = rent.minimum_balance(V2Vault::SIZE - 8); // subtract discriminator
    let vault_balance = vault_info.lamports();
    let distributable = vault_balance
        .checked_sub(rent_exempt_min)
        .ok_or(V2Error::VaultInsolvent)?;

    // -- Calculate pool and verify against distributable --
    let round = &ctx.accounts.round;
    let pool = round
        .total_deposits
        .checked_add(round.rollover_in)
        .ok_or(V2Error::MathOverflow)?;

    require!(pool <= distributable, V2Error::VaultInsolvent);

    // -- BPS payout math (V2: 50% winner, 30% rollover, 15% YES pool, 5% treasury) --
    let winner_amount = pool
        .checked_mul(BPS_WINNER)
        .ok_or(V2Error::MathOverflow)?
        .checked_div(BPS_TOTAL)
        .ok_or(V2Error::MathOverflow)?;

    let yes_pool_amount = pool
        .checked_mul(BPS_YES_POOL)
        .ok_or(V2Error::MathOverflow)?
        .checked_div(BPS_TOTAL)
        .ok_or(V2Error::MathOverflow)?;

    let treasury_amount = pool
        .checked_mul(BPS_TREASURY)
        .ok_or(V2Error::MathOverflow)?
        .checked_div(BPS_TOTAL)
        .ok_or(V2Error::MathOverflow)?;

    // Rollover = residual (captures rounding dust) ≈ 30%
    let rollover_out = pool
        .checked_sub(winner_amount)
        .ok_or(V2Error::MathOverflow)?
        .checked_sub(yes_pool_amount)
        .ok_or(V2Error::MathOverflow)?
        .checked_sub(treasury_amount)
        .ok_or(V2Error::MathOverflow)?;

    // Handle YES pool: if no evidence, add to rollover
    let (final_yes_pool, final_rollover) = if round.total_yes_answers > 0 {
        (yes_pool_amount, rollover_out)
    } else {
        (0u64, rollover_out.checked_add(yes_pool_amount).ok_or(V2Error::MathOverflow)?)
    };

    // -- Distribute from vault (program-owned PDA) --

    // Winner (50%)
    transfer_from_vault(&vault_info, &ctx.accounts.winner, winner_amount)?;

    // Treasury (5%)
    transfer_from_vault(&vault_info, &ctx.accounts.treasury, treasury_amount)?;

    // -- Post-distribution invariant: vault must remain rent-exempt --
    require!(
        vault_info.lamports() >= rent_exempt_min,
        V2Error::VaultInsolvent
    );

    // -- Update rollover (direct assignment -- pool already includes rollover_in) --
    ctx.accounts.game_state.rollover_balance = final_rollover;

    // -- Update round state --
    let round = &mut ctx.accounts.round;
    round.status = V2RoundStatus::Settled;
    round.revealed_answer = answer;
    round.revealed_salt = salt;
    round.evidence_pool = final_yes_pool;
    // evidence_count and total_yes_answers already set by record_v2_evidence
    // evidence_claimed starts at 0

    emit!(V2RoundSettled {
        round_id: round.round_id,
        winner: ctx.accounts.winner.key(),
        pool,
        winner_amount,
        yes_pool_amount: final_yes_pool,
        treasury_amount,
        rollover_out: final_rollover,
    });

    Ok(())
}
