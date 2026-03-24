use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("21XdvvE67SYnRLLcLkFDTXMSkbLrJNh6Ndi5qe5ErZwg");

#[program]
pub mod alons_box_v2 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
        buyback_wallet: Pubkey,
        round_duration_secs: i64,
        entry_cutoff_secs: i64,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, treasury, buyback_wallet, round_duration_secs, entry_cutoff_secs)
    }

    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        commit_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_round::handler(ctx, round_id, commit_hash)
    }

    pub fn enter(ctx: Context<Enter>, amount: u64) -> Result<()> {
        instructions::enter::handler(ctx, amount)
    }

    pub fn settle(ctx: Context<Settle>, answer: String, salt: String) -> Result<()> {
        instructions::settle::handler(ctx, answer, salt)
    }

    pub fn expire(ctx: Context<Expire>, answer: String, salt: String) -> Result<()> {
        instructions::expire::handler(ctx, answer, salt)
    }

    pub fn force_expire(ctx: Context<ForceExpire>) -> Result<()> {
        instructions::force_expire::handler(ctx)
    }

    pub fn record_v2_evidence(ctx: Context<RecordV2Evidence>, round_id: u64) -> Result<()> {
        instructions::record_v2_evidence::handler(ctx, round_id)
    }

    pub fn claim_v2_evidence(ctx: Context<ClaimV2Evidence>, round_id: u64) -> Result<()> {
        instructions::claim_v2_evidence::handler(ctx, round_id)
    }

    pub fn sweep_v2_evidence(ctx: Context<SweepV2Evidence>, round_id: u64) -> Result<()> {
        instructions::sweep_v2_evidence::handler(ctx, round_id)
    }

    pub fn close_v2_evidence(ctx: Context<CloseV2Evidence>) -> Result<()> {
        instructions::close_v2_evidence::handler(ctx)
    }
}
