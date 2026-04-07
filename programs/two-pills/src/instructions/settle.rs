use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;
use crate::events::RoundSettled;
use crate::state::*;
use crate::utils::{transfer_from_vault, TREASURY_BPS, NRR_BPS};

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pills_state"],
        bump = game_state.bump,
        constraint = game_state.authority == authority.key() @ TwoPillsError::Unauthorized,
    )]
    pub game_state: Account<'info, PillsGameState>,

    #[account(
        mut,
        seeds = [b"pills_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == RoundStatus::Active @ TwoPillsError::RoundNotActive,
    )]
    pub round: Account<'info, PillsRound>,

    #[account(
        mut,
        seeds = [b"pills_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, PillsVault>,

    /// CHECK: Treasury — receives fee from loser deposits
    #[account(
        mut,
        constraint = treasury.key() == game_state.treasury @ TwoPillsError::Unauthorized,
    )]
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Settle>, winner: u8) -> Result<()> {
    let winner_side = match winner {
        1 => Side::A,
        2 => Side::B,
        _ => return Err(TwoPillsError::InvalidWinner.into()),
    };

    let round = &mut ctx.accounts.round;

    // [AUDIT FIX H-settle] Require round time has elapsed
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= round.ends_at,
        TwoPillsError::RoundNotEnded
    );

    // Require at least one real player (pools include seeds now, so check player counts)
    require!(
        round.players_a > 0 || round.players_b > 0,
        TwoPillsError::RoundHasNoDeposits
    );

    // [REVIEW FIX] Guard: winning side must have real players
    match winner_side {
        Side::A => require!(round.players_a > 0, TwoPillsError::NoPlayersOnWinningSide),
        Side::B => require!(round.players_b > 0, TwoPillsError::NoPlayersOnWinningSide),
        _ => {}
    }

    // Total pool = all deposits + seeds on both sides
    let total_pool = round.pool_a
        .checked_add(round.pool_b)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Calculate splits from total pool: 10% treasury, 20% NRR, 70% winners
    let treasury_amount = total_pool
        .checked_mul(TREASURY_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let nrr_share = total_pool
        .checked_mul(NRR_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Winners share = 70% of total pool
    let winners_share = total_pool
        .checked_sub(treasury_amount)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_sub(nrr_share)
        .ok_or(TwoPillsError::MathOverflow)?;

    let total_nrr_return = nrr_share;

    // [REVIEW FIX] Effects-before-interactions: update state BEFORE transfer
    round.status = RoundStatus::Settled;
    round.winner = winner_side;
    round.total_claimed = 0;
    round.treasury_paid = treasury_amount;
    round.nrr_returned = total_nrr_return;
    round.settled_at = clock.unix_timestamp;

    let game_state = &mut ctx.accounts.game_state;
    game_state.nrr_balance = game_state
        .nrr_balance
        .checked_add(total_nrr_return)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Transfer treasury fee from vault (interaction after effects)
    let vault_info = ctx.accounts.vault.to_account_info();
    transfer_from_vault(&vault_info, &ctx.accounts.treasury, treasury_amount)?;

    emit!(RoundSettled {
        round_id: round.round_id,
        winner,
        pool_a: round.pool_a,
        pool_b: round.pool_b,
        treasury_amount,
        nrr_returned: total_nrr_return,
        winners_share,
    });

    Ok(())
}
