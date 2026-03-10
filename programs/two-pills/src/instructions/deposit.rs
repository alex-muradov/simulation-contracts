use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::errors::TwoPillsError;
use crate::events::DepositMade;
use crate::state::*;
use crate::utils::is_valid_tier;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [b"pills_state"],
        bump = game_state.bump,
    )]
    pub game_state: Account<'info, PillsGameState>,

    #[account(
        mut,
        seeds = [b"pills_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == RoundStatus::Active @ TwoPillsError::RoundNotActive,
    )]
    pub round: Account<'info, PillsRound>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerPosition::SIZE,
        seeds = [
            b"position",
            round.round_id.to_le_bytes().as_ref(),
            player.key().as_ref(),
        ],
        bump,
    )]
    pub position: Account<'info, PlayerPosition>,

    #[account(
        mut,
        seeds = [b"pills_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, PillsVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, side: u8, amount: u64) -> Result<()> {
    // [AUDIT FIX C-3] Reject deposits after round end time
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < ctx.accounts.round.ends_at,
        TwoPillsError::RoundEnded
    );

    // Validate tier
    require!(is_valid_tier(amount), TwoPillsError::InvalidAmount);

    // Validate side
    let deposit_side = match side {
        1 => Side::A,
        2 => Side::B,
        _ => return Err(TwoPillsError::InvalidSide.into()),
    };

    let position = &mut ctx.accounts.position;

    // [AUDIT FIX C-1] Use explicit is_initialized flag instead of Pubkey::default sentinel
    if !position.is_initialized {
        position.player = ctx.accounts.player.key();
        position.round_id = ctx.accounts.round.round_id;
        position.side = deposit_side;
        position.total_deposited = 0;
        position.num_deposits = 0;
        position.claimed = false;
        position.is_initialized = true;
        position.bump = ctx.bumps.position;

        // Increment unique player count
        let round = &mut ctx.accounts.round;
        match deposit_side {
            Side::A => round.players_a = round.players_a.saturating_add(1),
            Side::B => round.players_b = round.players_b.saturating_add(1),
            _ => {}
        }
    } else {
        // Existing position: enforce side-lock
        require!(position.side == deposit_side, TwoPillsError::SideLocked);
    }

    // Check max deposits
    require!(position.num_deposits < 255, TwoPillsError::MaxDepositsReached);

    // Transfer SOL from player → vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update position
    position.total_deposited = position
        .total_deposited
        .checked_add(amount)
        .ok_or(TwoPillsError::MathOverflow)?;
    position.num_deposits = position
        .num_deposits
        .checked_add(1)
        .ok_or(TwoPillsError::MaxDepositsReached)?;

    // Update round pools
    let round = &mut ctx.accounts.round;
    match deposit_side {
        Side::A => {
            round.pool_a = round
                .pool_a
                .checked_add(amount)
                .ok_or(TwoPillsError::MathOverflow)?;
        }
        Side::B => {
            round.pool_b = round
                .pool_b
                .checked_add(amount)
                .ok_or(TwoPillsError::MathOverflow)?;
        }
        _ => {}
    }

    emit!(DepositMade {
        round_id: round.round_id,
        player: ctx.accounts.player.key(),
        side,
        amount,
        pool_a: round.pool_a,
        pool_b: round.pool_b,
    });

    Ok(())
}
