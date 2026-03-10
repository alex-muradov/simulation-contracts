use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;
use crate::events::RoundExpired;
use crate::state::*;

#[derive(Accounts)]
pub struct Expire<'info> {
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
}

pub fn handler(ctx: Context<Expire>) -> Result<()> {
    let round = &ctx.accounts.round;

    // Only expire rounds with zero deposits
    require!(
        round.pool_a == 0 && round.pool_b == 0,
        TwoPillsError::RoundHasDeposits
    );

    // Return seeds to NRR
    let seeds_total = round
        .seed_a
        .checked_add(round.seed_b)
        .ok_or(TwoPillsError::MathOverflow)?;

    let game_state = &mut ctx.accounts.game_state;
    game_state.nrr_balance = game_state
        .nrr_balance
        .checked_add(seeds_total)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Update round status
    let round = &mut ctx.accounts.round;
    round.status = RoundStatus::Expired;

    emit!(RoundExpired {
        round_id: round.round_id,
        seeds_returned: seeds_total,
    });

    Ok(())
}
