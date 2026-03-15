use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::events::V2GameInitialized;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = V2GameState::SIZE,
        seeds = [b"v2_game_state"],
        bump,
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        init,
        payer = authority,
        space = V2Vault::SIZE,
        seeds = [b"v2_vault"],
        bump,
    )]
    pub vault: Account<'info, V2Vault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    treasury: Pubkey,
    buyback_wallet: Pubkey,
    round_duration_secs: i64,
    entry_cutoff_secs: i64,
) -> Result<()> {
    require!(round_duration_secs > 0, V2Error::InvalidRoundDuration);
    require!(
        entry_cutoff_secs >= 0 && entry_cutoff_secs < round_duration_secs,
        V2Error::InvalidEntryCutoff
    );

    let game_state = &mut ctx.accounts.game_state;
    game_state.authority = ctx.accounts.authority.key();
    game_state.treasury = treasury;
    game_state.buyback_wallet = buyback_wallet;
    game_state.current_round_id = 0;
    game_state.rollover_balance = 0;
    game_state.round_duration_secs = round_duration_secs;
    game_state.entry_cutoff_secs = entry_cutoff_secs;
    game_state.bump = ctx.bumps.game_state;

    let vault = &mut ctx.accounts.vault;
    vault.bump = ctx.bumps.vault;

    emit!(V2GameInitialized {
        authority: game_state.authority,
        treasury,
        buyback_wallet,
    });

    Ok(())
}
