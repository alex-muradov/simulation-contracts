use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;
use crate::events::RoundCreated;
use crate::state::*;
use crate::utils::MIN_NRR_SEED;

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
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
        init,
        payer = authority,
        space = PillsRound::SIZE,
        seeds = [b"pills_round", round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, PillsRound>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateRound>, round_id: u64, ends_at: i64) -> Result<()> {
    let game_state = &mut ctx.accounts.game_state;

    // Validate round_id is next sequential
    require!(
        round_id == game_state.round_counter + 1,
        TwoPillsError::InvalidRoundId
    );

    // Validate ends_at is in the future
    let clock = Clock::get()?;
    require!(ends_at > clock.unix_timestamp, TwoPillsError::InvalidEndTime);

    // Consume NRR for seeds
    let (seed_a, seed_b) = if game_state.nrr_balance >= MIN_NRR_SEED {
        let half = game_state.nrr_balance / 2;
        game_state.nrr_balance = game_state
            .nrr_balance
            .checked_sub(half * 2)
            .ok_or(TwoPillsError::MathOverflow)?;
        (half, half)
    } else {
        (0, 0)
    };

    game_state.round_counter = round_id;

    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    // Seeds enter pools as real initial liquidity (NRR subsidizes rounds)
    round.pool_a = seed_a;
    round.pool_b = seed_b;
    round.players_a = 0;
    round.players_b = 0;
    round.seed_a = seed_a;
    round.seed_b = seed_b;
    round.status = RoundStatus::Active;
    round.winner = Side::None;
    round.ends_at = ends_at;
    round.total_claimed = 0;
    round.treasury_paid = 0;
    round.nrr_returned = 0;
    round.settled_at = 0;
    round.swept = false;
    round.bump = ctx.bumps.round;

    emit!(RoundCreated {
        round_id,
        ends_at,
        seed_a,
        seed_b,
    });

    Ok(())
}
