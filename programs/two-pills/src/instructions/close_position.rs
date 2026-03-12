use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;
use crate::state::*;

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [b"pills_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status != RoundStatus::Active @ TwoPillsError::RoundNotSettled,
    )]
    pub round: Account<'info, PillsRound>,

    #[account(
        mut,
        close = player,
        seeds = [
            b"position",
            round.round_id.to_le_bytes().as_ref(),
            player.key().as_ref(),
        ],
        bump = position.bump,
        constraint = position.player == player.key() @ TwoPillsError::Unauthorized,
        // Winners must claim before closing
        constraint = position.side != round.winner || position.claimed @ TwoPillsError::MustClaimFirst,
    )]
    pub position: Account<'info, PlayerPosition>,
}

pub fn handler(_ctx: Context<ClosePosition>) -> Result<()> {
    Ok(())
}
