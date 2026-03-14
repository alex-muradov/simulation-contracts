use anchor_lang::prelude::*;

// ---- V2GameState PDA ---- seeds: ["v2_game_state"]
#[account]
pub struct V2GameState {
    pub authority: Pubkey,        // 32
    pub treasury: Pubkey,         // 32
    pub buyback_wallet: Pubkey,   // 32
    pub current_round_id: u64,    // 8
    pub rollover_balance: u64,    // 8
    pub round_duration_secs: i64, // 8 (default 1200 = 20 min)
    pub entry_cutoff_secs: i64,   // 8 (default 180 = 3 min)
    pub bump: u8,                 // 1
}

impl V2GameState {
    // 8 disc + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 = 137
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

// ---- V2RoundStatus ----
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum V2RoundStatus {
    Active,
    Settled,
    Expired,
}

// ---- V2Round PDA ---- seeds: ["v2_round", round_id (u64 LE)]
#[account]
pub struct V2Round {
    pub round_id: u64,           // 8
    pub commit_hash: [u8; 32],   // 32
    pub authority: Pubkey,       // 32
    pub started_at: i64,         // 8
    pub ends_at: i64,            // 8
    pub entry_cutoff: i64,       // 8
    pub status: V2RoundStatus,   // 1
    pub total_entries: u64,      // 8
    pub total_deposits: u64,     // 8
    pub rollover_in: u64,        // 8
    pub revealed_answer: String, // 4 + 64 max
    pub revealed_salt: String,   // 4 + 64 max
    pub bump: u8,                // 1
    pub evidence_count: u64,     // 8 -- unique wallets with YES answers
    pub total_yes_answers: u64,  // 8 -- sum of yes_count across all wallets
    pub evidence_pool: u64,      // 8 -- 15% of pool, set at settle
    pub evidence_claimed: u64,   // 8 -- running total of claimed lamports
}

impl V2Round {
    // 8 disc + 8 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + (4+64) + (4+64) + 1 + 8 + 8 + 8 + 8 = 298
    pub const SIZE: usize = 8 + 8 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + (4 + 64) + (4 + 64) + 1 + 8 + 8 + 8 + 8;
}

// ---- V2Entry PDA ---- seeds: ["v2_entry", round_id (u64 LE), player pubkey]
#[account]
pub struct V2Entry {
    pub round_id: u64,     // 8
    pub player: Pubkey,    // 32
    pub amount_paid: u64,  // 8
    pub entered_at: i64,   // 8
    pub bump: u8,          // 1
}

impl V2Entry {
    // 8 disc + 8 + 32 + 8 + 8 + 1 = 65
    pub const SIZE: usize = 8 + 8 + 32 + 8 + 8 + 1;
}

// ---- V2Evidence PDA ---- seeds: ["v2_evidence", round_id (u64 LE), wallet pubkey]
#[account]
pub struct V2Evidence {
    pub round_id: u64,      // 8
    pub wallet: Pubkey,      // 32
    pub yes_count: u64,      // 8 -- number of public YES answers for this wallet
    pub claimed: bool,       // 1
    pub initialized: bool,   // 1 -- needed for init_if_needed pattern
    pub bump: u8,            // 1
}

impl V2Evidence {
    // 8 disc + 8 + 32 + 8 + 1 + 1 + 1 = 59
    pub const SIZE: usize = 8 + 8 + 32 + 8 + 1 + 1 + 1;
}

// ---- V2Vault PDA ---- seeds: ["v2_vault"]
#[account]
pub struct V2Vault {
    pub bump: u8, // 1
}

impl V2Vault {
    // 8 disc + 1 = 9
    pub const SIZE: usize = 8 + 1;
}
