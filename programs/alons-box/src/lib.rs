//! Alon's Box — Trustless crypto-AI guessing game on Solana.
//!
//! Players deposit SOL into a program-owned escrow and compete to guess a
//! secret answer. The answer is cryptographically committed (SHA-256) before
//! deposits, ensuring provably fair outcomes via an on-chain commit-reveal scheme.
//!
//! Docs: https://simulation-theory.gitbook.io/simulation-theory-docs

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa");

#[program]
pub mod alons_box {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey, buyback_wallet: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, treasury, buyback_wallet)
    }

    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        commit_hash: [u8; 32],
        ends_at: i64,
    ) -> Result<()> {
        instructions::create_round::handler(ctx, round_id, commit_hash, ends_at)
    }

    pub fn deposit(ctx: Context<DepositCtx>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    pub fn settle<'info>(
        ctx: Context<'_, '_, 'info, 'info, Settle<'info>>,
        answer: String,
        salt: String,
        evidence_amounts: Vec<u64>,
    ) -> Result<()> {
        instructions::settle::handler(ctx, answer, salt, evidence_amounts)
    }

    pub fn expire(ctx: Context<Expire>, answer: String, salt: String) -> Result<()> {
        instructions::expire::handler(ctx, answer, salt)
    }

    pub fn emergency_expire(ctx: Context<EmergencyExpire>) -> Result<()> {
        instructions::emergency_expire::handler(ctx)
    }

    pub fn close_deposit(ctx: Context<CloseDeposit>) -> Result<()> {
        instructions::close_deposit::handler(ctx)
    }

    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        instructions::close_round::handler(ctx)
    }

    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        instructions::migrate::handler(ctx)
    }
}
