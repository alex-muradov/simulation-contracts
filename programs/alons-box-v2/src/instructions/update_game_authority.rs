use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::events::V2GameAuthorityUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdateGameAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
        constraint = game_state.authority == authority.key() @ V2Error::Unauthorized,
    )]
    pub game_state: Account<'info, V2GameState>,
}

pub fn handler(ctx: Context<UpdateGameAuthority>, new_authority: Pubkey) -> Result<()> {
    let game_state = &mut ctx.accounts.game_state;
    let old_authority = game_state.authority;
    game_state.authority = new_authority;

    emit!(V2GameAuthorityUpdated {
        old_authority,
        new_authority,
    });

    Ok(())
}
