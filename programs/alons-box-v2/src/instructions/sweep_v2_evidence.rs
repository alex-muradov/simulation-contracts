use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::events::V2EvidenceSwept;
use crate::state::*;

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SweepV2Evidence<'info> {
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
        seeds = [b"v2_round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == V2RoundStatus::Settled @ V2Error::RoundNotSettled,
    )]
    pub round: Account<'info, V2Round>,

    #[account(
        mut,
        seeds = [b"v2_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, V2Vault>,
}

pub fn handler(ctx: Context<SweepV2Evidence>, _round_id: u64) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let game_state = &mut ctx.accounts.game_state;

    let unclaimed = round.evidence_pool
        .checked_sub(round.evidence_claimed)
        .ok_or(V2Error::MathOverflow)?;

    require!(unclaimed > 0, V2Error::NothingToClaim);

    // Move unclaimed evidence to rollover (stays in vault, just tracked in game_state)
    game_state.rollover_balance = game_state.rollover_balance
        .checked_add(unclaimed)
        .ok_or(V2Error::MathOverflow)?;

    // Mark all evidence as claimed by zeroing the remaining pool
    round.evidence_claimed = round.evidence_pool;

    emit!(V2EvidenceSwept {
        round_id: round.round_id,
        unclaimed_amount: unclaimed,
    });

    Ok(())
}
