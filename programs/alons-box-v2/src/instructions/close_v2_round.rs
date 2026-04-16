use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseV2Round<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
        constraint = game_state.authority == authority.key() @ V2Error::Unauthorized,
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        mut,
        close = authority,
        seeds = [b"v2_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status != V2RoundStatus::Active @ V2Error::RoundStillActive,
        constraint = round.evidence_pool == 0 || round.evidence_pool == round.evidence_claimed @ V2Error::EvidenceNotResolved,
    )]
    pub round: Account<'info, V2Round>,
}

pub fn handler(ctx: Context<CloseV2Round>) -> Result<()> {
    msg!(
        "Closed V2 round PDA for round {}",
        ctx.accounts.round.round_id
    );
    Ok(())
}
