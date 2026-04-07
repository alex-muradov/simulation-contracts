use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;
use crate::events::UnclaimedSwept;
use crate::state::*;
use crate::utils::{SWEEP_WINDOW, TREASURY_BPS, NRR_BPS};

#[derive(Accounts)]
pub struct SweepUnclaimed<'info> {
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
        constraint = round.status == RoundStatus::Settled @ TwoPillsError::RoundNotSettled,
        constraint = !round.swept @ TwoPillsError::AlreadySwept,
    )]
    pub round: Account<'info, PillsRound>,
}

pub fn handler(ctx: Context<SweepUnclaimed>) -> Result<()> {
    let round = &ctx.accounts.round;

    // [AUDIT FIX L-5] Use settled_at (not ends_at) for sweep window — guarantees
    // winners always have exactly 7 days from settlement to claim
    let clock = Clock::get()?;
    require!(
        round.settled_at > 0 && clock.unix_timestamp > round.settled_at + SWEEP_WINDOW,
        TwoPillsError::SweepWindowNotElapsed
    );

    // Total pool = all deposits + seeds
    let total_pool = round.pool_a
        .checked_add(round.pool_b)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Winners share = 70% of total pool
    let treasury_amount = total_pool
        .checked_mul(TREASURY_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let nrr_amount = total_pool
        .checked_mul(NRR_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let winners_share = total_pool
        .checked_sub(treasury_amount)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_sub(nrr_amount)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Max payable = winners_share (no separate stake-back)
    let unclaimed = winners_share
        .checked_sub(round.total_claimed)
        .ok_or(TwoPillsError::MathOverflow)?;

    let total_sweep = unclaimed;

    // Add unclaimed + winner seed to NRR (SOL stays in vault, accounted in GameState)
    let game_state = &mut ctx.accounts.game_state;
    game_state.nrr_balance = game_state
        .nrr_balance
        .checked_add(total_sweep)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Mark as swept
    let round = &mut ctx.accounts.round;
    round.swept = true;

    emit!(UnclaimedSwept {
        round_id: round.round_id,
        amount: total_sweep,
    });

    Ok(())
}
