use anchor_lang::prelude::*;
use crate::events::GameInitialized;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = PillsGameState::SIZE,
        seeds = [b"pills_state"],
        bump,
    )]
    pub game_state: Account<'info, PillsGameState>,

    #[account(
        init,
        payer = authority,
        space = PillsVault::SIZE,
        seeds = [b"pills_vault"],
        bump,
    )]
    pub vault: Account<'info, PillsVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, treasury: Pubkey) -> Result<()> {
    let game_state = &mut ctx.accounts.game_state;
    game_state.authority = ctx.accounts.authority.key();
    game_state.treasury = treasury;
    game_state.nrr_balance = 0;
    game_state.round_counter = 0;
    game_state.bump = ctx.bumps.game_state;

    let vault = &mut ctx.accounts.vault;
    vault.bump = ctx.bumps.vault;

    emit!(GameInitialized {
        authority: game_state.authority,
        treasury,
    });

    Ok(())
}
