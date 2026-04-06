use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::errors::V2Error;
use crate::events::V2DonationMade;
use crate::state::*;

#[derive(Accounts)]
pub struct Donate<'info> {
    #[account(mut)]
    pub donor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        mut,
        seeds = [b"v2_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, V2Vault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Donate>, amount: u64) -> Result<()> {
    require!(amount > 0, V2Error::InvalidDonation);

    // CPI transfer SOL from donor to vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.donor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    // Increment rollover balance
    let game_state = &mut ctx.accounts.game_state;
    game_state.rollover_balance = game_state
        .rollover_balance
        .checked_add(amount)
        .ok_or(V2Error::MathOverflow)?;

    emit!(V2DonationMade {
        donor: ctx.accounts.donor.key(),
        amount,
        new_rollover_balance: game_state.rollover_balance,
    });

    Ok(())
}
