use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::constants::{BASE_ENTRY_FEE, ENTRY_FEE_INCREMENT, PRICE_INTERVAL_SECS};
use crate::errors::V2Error;
use crate::events::V2EntryMade;
use crate::state::*;

/// Calculate the entry fee based on elapsed time since round start.
/// Fee = BASE_ENTRY_FEE + (intervals * ENTRY_FEE_INCREMENT)
/// where intervals = elapsed_seconds / PRICE_INTERVAL_SECS (integer division).
pub fn calculate_entry_fee(started_at: i64, now: i64) -> Result<u64> {
    let elapsed = now.checked_sub(started_at).ok_or(V2Error::MathOverflow)?;
    let intervals = (elapsed / PRICE_INTERVAL_SECS) as u64;
    let fee = BASE_ENTRY_FEE
        .checked_add(
            intervals
                .checked_mul(ENTRY_FEE_INCREMENT)
                .ok_or(V2Error::MathOverflow)?,
        )
        .ok_or(V2Error::MathOverflow)?;
    Ok(fee)
}

#[derive(Accounts)]
pub struct Enter<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [b"v2_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == V2RoundStatus::Active @ V2Error::RoundNotActive,
    )]
    pub round: Account<'info, V2Round>,

    #[account(
        init,
        payer = player,
        space = V2Entry::SIZE,
        seeds = [
            b"v2_entry",
            round.round_id.to_le_bytes().as_ref(),
            player.key().as_ref(),
        ],
        bump,
    )]
    pub entry: Account<'info, V2Entry>,

    #[account(
        mut,
        seeds = [b"v2_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, V2Vault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Enter>, amount: u64) -> Result<()> {
    // Read on-chain clock
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let round = &ctx.accounts.round;

    // Enforce entry cutoff: reject entries after cutoff time
    require!(now < round.entry_cutoff, V2Error::EntryClosed);

    // Calculate expected fee based on elapsed time
    let expected_fee = calculate_entry_fee(round.started_at, now)?;

    // Validate amount: accept overpayment (handles tier boundary clock drift)
    require!(amount >= expected_fee, V2Error::InsufficientEntryFee);

    // CPI transfer SOL from player to vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    // Set entry fields
    let entry = &mut ctx.accounts.entry;
    entry.round_id = round.round_id;
    entry.player = ctx.accounts.player.key();
    entry.amount_paid = amount;
    entry.entered_at = now;
    entry.bump = ctx.bumps.entry;

    // Update round totals
    let round = &mut ctx.accounts.round;
    round.total_entries = round
        .total_entries
        .checked_add(1)
        .ok_or(V2Error::MathOverflow)?;
    round.total_deposits = round
        .total_deposits
        .checked_add(amount)
        .ok_or(V2Error::MathOverflow)?;

    // Calculate fee tier for event
    let fee_tier = (now
        .checked_sub(round.started_at)
        .ok_or(V2Error::MathOverflow)?
        / PRICE_INTERVAL_SECS) as u64;

    emit!(V2EntryMade {
        round_id: round.round_id,
        player: ctx.accounts.player.key(),
        amount_paid: amount,
        fee_tier,
        total_deposits: round.total_deposits,
        total_entries: round.total_entries,
    });

    Ok(())
}
