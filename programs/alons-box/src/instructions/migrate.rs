use anchor_lang::prelude::*;
use crate::errors::AlonsBoxError;
use crate::state::GameState;

/// Migrate cannot use `Account<GameState>` because the on-chain account is
/// still the OLD size (113 bytes) and Anchor would fail to deserialize it
/// into the NEW struct (121 bytes) before realloc even runs.
///
/// Instead we take a raw `UncheckedAccount`, verify the PDA manually, read
/// the authority from the old byte layout, realloc, and zero-fill the new
/// bytes so the account matches the current GameState layout.
#[derive(Accounts)]
pub struct Migrate<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Verified manually — PDA seeds, owner, and authority field.
    #[account(mut)]
    pub game_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Migrate>) -> Result<()> {
    let game_state_info = &ctx.accounts.game_state;

    // ── 1. Verify PDA seeds ──
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[b"game_state"],
        ctx.program_id,
    );
    require!(
        game_state_info.key() == expected_pda,
        AlonsBoxError::Unauthorized
    );

    // ── 2. Verify owner is this program ──
    require!(
        game_state_info.owner == ctx.program_id,
        AlonsBoxError::Unauthorized
    );

    // ── 3. Read authority from old layout (bytes 8..40, after 8-byte discriminator) ──
    let data = game_state_info.try_borrow_data()?;
    require!(data.len() >= 40, AlonsBoxError::Unauthorized);
    let stored_authority = Pubkey::try_from(&data[8..40])
        .map_err(|_| AlonsBoxError::Unauthorized)?;
    require!(
        stored_authority == ctx.accounts.authority.key(),
        AlonsBoxError::Unauthorized
    );

    let old_len = data.len();
    let new_len = GameState::SIZE;

    // Already migrated — nothing to do
    if old_len >= new_len {
        msg!("game_state already at {} bytes, no migration needed", old_len);
        return Ok(());
    }
    drop(data);

    // ── 4. Transfer lamports for additional rent ──
    let rent = Rent::get()?;
    let new_min_balance = rent.minimum_balance(new_len);
    let lamports_needed = new_min_balance.saturating_sub(game_state_info.lamports());
    if lamports_needed > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: game_state_info.to_account_info(),
                },
            ),
            lamports_needed,
        )?;
    }

    // ── 5. Realloc the account ──
    game_state_info.realloc(new_len, false)?;

    // ── 6. Zero-fill the new bytes (rollover_balance = 0) ──
    let mut data = game_state_info.try_borrow_mut_data()?;
    for byte in data[old_len..new_len].iter_mut() {
        *byte = 0;
    }

    msg!("game_state migrated from {} to {} bytes", old_len, new_len);
    Ok(())
}
