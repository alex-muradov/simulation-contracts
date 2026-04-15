use anchor_lang::prelude::*;
use crate::errors::TwoPillsError;
use crate::events::PayoutClaimed;
use crate::state::*;
use crate::utils::{transfer_from_vault, TREASURY_BPS, NRR_BPS};

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Can be the player themselves or the authority (auto-claim)
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [b"pills_state"],
        bump = game_state.bump,
    )]
    pub game_state: Account<'info, PillsGameState>,

    #[account(
        mut,
        seeds = [b"pills_round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == RoundStatus::Settled @ TwoPillsError::RoundNotSettled,
        constraint = !round.swept @ TwoPillsError::AlreadySwept,
    )]
    pub round: Account<'info, PillsRound>,

    #[account(
        mut,
        seeds = [
            b"position",
            round.round_id.to_le_bytes().as_ref(),
            position.player.as_ref(),
        ],
        bump = position.bump,
        constraint = position.side == round.winner @ TwoPillsError::NotWinner,
        constraint = !position.claimed @ TwoPillsError::AlreadyClaimed,
    )]
    pub position: Account<'info, PlayerPosition>,

    #[account(
        mut,
        seeds = [b"pills_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, PillsVault>,

    /// CHECK: The player wallet that receives the payout
    #[account(
        mut,
        constraint = beneficiary.key() == position.player @ TwoPillsError::Unauthorized,
    )]
    pub beneficiary: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let signer_key = ctx.accounts.signer.key();
    let position = &ctx.accounts.position;
    let game_state = &ctx.accounts.game_state;

    // Only the player or authority can claim
    require!(
        signer_key == position.player || signer_key == game_state.authority,
        TwoPillsError::Unauthorized
    );

    let round = &ctx.accounts.round;

    // Total pool = all deposits + seeds
    let total_pool = round.pool_a
        .checked_add(round.pool_b)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Recalculate winners_share = 70% of total pool
    let treasury_amount = total_pool
        .checked_mul(TREASURY_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let nrr_amount = total_pool
        .checked_mul(NRR_BPS)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_div(10000)
        .ok_or(TwoPillsError::MathOverflow)?;

    let winners_share = total_pool
        .checked_sub(treasury_amount)
        .ok_or(TwoPillsError::MathOverflow)?
        .checked_sub(nrr_amount)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Winner pool = total deposits on winning side (including seed)
    let winner_pool = match round.winner {
        Side::A => round.pool_a,
        Side::B => round.pool_b,
        _ => return Err(TwoPillsError::RoundNotSettled.into()),
    };

    // Payout = proportional share of 70% winners pool (no separate stake-back)
    let payout: u64 = if winner_pool > 0 {
        let numerator = (position.total_deposited as u128)
            .checked_mul(winners_share as u128)
            .ok_or(TwoPillsError::MathOverflow)?;
        let result = numerator
            .checked_div(winner_pool as u128)
            .ok_or(TwoPillsError::MathOverflow)?;
        result as u64
    } else {
        0
    };

    // [REVIEW FIX] Effects-before-interactions: update state BEFORE transfer
    let position = &mut ctx.accounts.position;
    position.claimed = true;

    let round = &mut ctx.accounts.round;
    round.total_claimed = round
        .total_claimed
        .checked_add(payout)
        .ok_or(TwoPillsError::MathOverflow)?;

    // Transfer from vault → beneficiary (interaction after effects)
    let vault_info = ctx.accounts.vault.to_account_info();
    transfer_from_vault(&vault_info, &ctx.accounts.beneficiary, payout)?;

    emit!(PayoutClaimed {
        round_id: round.round_id,
        player: position.player,
        payout,
    });

    Ok(())
}
