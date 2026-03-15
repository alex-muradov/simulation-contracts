use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseV2Evidence<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
        constraint = game_state.authority == authority.key() @ V2Error::Unauthorized,
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        seeds = [b"v2_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status != V2RoundStatus::Active @ V2Error::RoundStillActive,
    )]
    pub round: Account<'info, V2Round>,

    #[account(
        mut,
        close = authority,
        seeds = [
            b"v2_evidence",
            evidence.round_id.to_le_bytes().as_ref(),
            evidence.wallet.as_ref(),
        ],
        bump = evidence.bump,
        constraint = evidence.round_id == round.round_id,
    )]
    pub evidence: Account<'info, V2Evidence>,
}

pub fn handler(ctx: Context<CloseV2Evidence>) -> Result<()> {
    // Anchor `close = authority` handles rent recovery automatically
    msg!(
        "Closed V2 evidence PDA for round {} wallet {}",
        ctx.accounts.evidence.round_id,
        ctx.accounts.evidence.wallet
    );
    Ok(())
}
