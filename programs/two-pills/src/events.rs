use anchor_lang::prelude::*;

#[event]
pub struct GameInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
}

#[event]
pub struct RoundCreated {
    pub round_id: u64,
    pub ends_at: i64,
    pub seed_a: u64,
    pub seed_b: u64,
}

#[event]
pub struct DepositMade {
    pub round_id: u64,
    pub player: Pubkey,
    pub side: u8,     // 1=A, 2=B
    pub amount: u64,
    pub pool_a: u64,
    pub pool_b: u64,
}

#[event]
pub struct RoundSettled {
    pub round_id: u64,
    pub winner: u8,   // 1=A, 2=B
    pub pool_a: u64,
    pub pool_b: u64,
    pub treasury_amount: u64,
    pub nrr_returned: u64,
    pub winners_share: u64,
}

#[event]
pub struct PayoutClaimed {
    pub round_id: u64,
    pub player: Pubkey,
    pub payout: u64,
}

#[event]
pub struct RoundExpired {
    pub round_id: u64,
    pub seeds_returned: u64,
}

#[event]
pub struct UnclaimedSwept {
    pub round_id: u64,
    pub amount: u64,
}
