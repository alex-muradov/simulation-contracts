//! Two Pills — AI-judged debate game on Solana.
//!
//! Players pick a side (A or B), submit arguments with SOL deposits.
//! An AI judge evaluates arguments and picks a winner. Winners split
//! the losing side's deposits proportionally to their stake.
//!
//! Follows the Alon's Box contract pattern (same authority model).

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("7SbPUmDW8L44k7KRbxpMo7hBh4ocpv9kszpWz5iNPJLW");

#[program]
pub mod two_pills {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, treasury)
    }

    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        ends_at: i64,
    ) -> Result<()> {
        instructions::create_round::handler(ctx, round_id, ends_at)
    }

    pub fn deposit(ctx: Context<Deposit>, side: u8, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, side, amount)
    }

    pub fn settle(ctx: Context<Settle>, winner: u8) -> Result<()> {
        instructions::settle::handler(ctx, winner)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }

    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        instructions::expire::handler(ctx)
    }

    pub fn sweep_unclaimed(ctx: Context<SweepUnclaimed>) -> Result<()> {
        instructions::sweep_unclaimed::handler(ctx)
    }
}
