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

    // Enforce sweep window (7 days after round ends)
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > round.ends_at + SWEEP_WINDOW,
        TwoPillsError::SweepWindowNotElapsed
    );

    // Calculate max possible claims (what all winners could claim)
    let (winner_pool, loser_deposits) = match round.winner {
        Side::A => (round.pool_a, round.pool_b),
        Side::B => (round.pool_b, round.pool_a),
        _ => return Err(TwoPillsError::RoundNotSettled.into()),
    };

    let treasury_amount = loser_deposits
        .checked_mul(TREASURY_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let nrr_amount = loser_deposits
        .checked_mul(NRR_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let winners_share = loser_deposits
        .checked_sub(treasury_amount)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_sub(nrr_amount)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Max payable = all winner stakes back + all winnings
    let max_payable = winner_pool
        .checked_add(winners_share)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Unclaimed = what hasn't been claimed yet
    let unclaimed = max_payable
        .checked_sub(round.total_claimed)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Add unclaimed to NRR (SOL stays in vault, accounted in GameState)
    let game_state = &mut ctx.accounts.game_state;
    game_state.nrr_balance = game_state
        .nrr_balance
        .checked_add(unclaimed)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Mark as swept
    let round = &mut ctx.accounts.round;
    round.swept = true;

    emit!(UnclaimedSwept {
        round_id: round.round_id,
        amount: unclaimed,
    });

    Ok(())
}
