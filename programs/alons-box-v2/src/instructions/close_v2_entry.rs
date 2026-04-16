use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::state::*;

#[derive(Accounts)]
pub struct CloseV2Entry<'info> {
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
        close = player,
        seeds = [
            b"v2_entry",
            entry.round_id.to_le_bytes().as_ref(),
            entry.player.as_ref(),
        ],
        bump = entry.bump,
        constraint = entry.round_id == round.round_id,
    )]
    pub entry: Account<'info, V2Entry>,

    /// CHECK: Original player who paid rent — must match entry.player
    #[account(mut, constraint = player.key() == entry.player @ V2Error::Unauthorized)]
    pub player: AccountInfo<'info>,
}

pub fn handler(ctx: Context<CloseV2Entry>) -> Result<()> {
    msg!(
        "Closed V2 entry PDA for round {} player {}",
        ctx.accounts.entry.round_id,
        ctx.accounts.entry.player
    );
    Ok(())
}
