use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::events::V2RoundCreated;
use crate::state::*;

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
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
        init,
        payer = authority,
        space = V2Round::SIZE,
        seeds = [b"v2_round", round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub round: Account<'info, V2Round>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateRound>,
    round_id: u64,
    commit_hash: [u8; 32],
) -> Result<()> {
    let game_state = &mut ctx.accounts.game_state;

    // Validate round_id is the next sequential ID
    require!(
        round_id == game_state.current_round_id + 1,
        V2Error::InvalidRoundId
    );

    // Derive timer from on-chain Clock
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let started_at = now;
    let ends_at = now
        .checked_add(game_state.round_duration_secs)
        .ok_or(V2Error::MathOverflow)?;
    let entry_cutoff = ends_at
        .checked_sub(game_state.entry_cutoff_secs)
        .ok_or(V2Error::MathOverflow)?;

    // Update game state
    game_state.current_round_id = round_id;

    // Carry rollover from previous rounds
    let rollover = game_state.rollover_balance;

    // Initialize round
    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    round.commit_hash = commit_hash;
    round.authority = ctx.accounts.authority.key();
    round.started_at = started_at;
    round.ends_at = ends_at;
    round.entry_cutoff = entry_cutoff;
    round.status = V2RoundStatus::Active;
    round.total_entries = 0;
    round.total_deposits = 0;
    round.rollover_in = rollover;
    round.revealed_answer = String::new();
    round.revealed_salt = String::new();
    round.bump = ctx.bumps.round;

    emit!(V2RoundCreated {
        round_id,
        started_at,
        ends_at,
        entry_cutoff,
        rollover_in: rollover,
    });

    Ok(())
}
