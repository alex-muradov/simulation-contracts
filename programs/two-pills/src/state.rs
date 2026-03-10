use anchor_lang::prelude::*;

// ── Side enum ──
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    None, // 0 — default / unset
    A,    // 1
    B,    // 2
}

// ── Round status enum ──
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RoundStatus {
    Active,  // 0
    Settled, // 1
    Expired, // 2
}

// ── PillsGameState PDA ── seeds: ["pills_state"]
#[account]
pub struct PillsGameState {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub nrr_balance: u64,    // Next Round Reserve in lamports
    pub round_counter: u64,
    pub bump: u8,
}

impl PillsGameState {
    // 8 disc + 32 + 32 + 8 + 8 + 1 = 89
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

// ── PillsVault PDA ── seeds: ["pills_vault"]
// Holds all SOL for the program.
#[account]
pub struct PillsVault {
    pub bump: u8,
}

impl PillsVault {
    pub const SIZE: usize = 8 + 1;
}

// ── PillsRound PDA ── seeds: ["pills_round", round_id (u64 LE)]
#[account]
pub struct PillsRound {
    pub round_id: u64,
    pub pool_a: u64,         // total deposits side A (lamports)
    pub pool_b: u64,         // total deposits side B (lamports)
    pub players_a: u16,      // unique player count side A
    pub players_b: u16,      // unique player count side B
    pub seed_a: u64,         // NRR seed allocated to side A
    pub seed_b: u64,         // NRR seed allocated to side B
    pub status: RoundStatus,
    pub winner: Side,
    pub ends_at: i64,
    pub total_claimed: u64,  // total lamports claimed by winners so far
    pub treasury_paid: u64,  // treasury fee already paid
    pub nrr_returned: u64,   // NRR share already returned
    pub settled_at: i64,     // unix timestamp when settled (0 if not yet)
    pub swept: bool,         // whether unclaimed funds were swept
    pub bump: u8,
}

impl PillsRound {
    // 8 disc + 8 + 8 + 8 + 2 + 2 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 1 + 1 = 96
    pub const SIZE: usize = 8 + 8 + 8 + 8 + 2 + 2 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
}

// ── PlayerPosition PDA ── seeds: ["position", round_id (u64 LE), player pubkey]
#[account]
pub struct PlayerPosition {
    pub player: Pubkey,
    pub round_id: u64,
    pub side: Side,
    pub total_deposited: u64,
    pub num_deposits: u8,
    pub claimed: bool,
    pub is_initialized: bool, // explicit init flag (safer than Pubkey::default sentinel)
    pub bump: u8,
}

impl PlayerPosition {
    // 8 disc + 32 + 8 + 1 + 8 + 1 + 1 + 1 + 1 = 61
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 8 + 1 + 1 + 1 + 1;
}
