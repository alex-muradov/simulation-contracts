use anchor_lang::prelude::*;

#[event]
pub struct V2GameInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub buyback_wallet: Pubkey,
}

#[event]
pub struct V2RoundCreated {
    pub round_id: u64,
    pub started_at: i64,
    pub ends_at: i64,
    pub entry_cutoff: i64,
    pub rollover_in: u64,
}

#[event]
pub struct V2EntryMade {
    pub round_id: u64,
    pub player: Pubkey,
    pub amount_paid: u64,
    pub fee_tier: u64,
    pub total_deposits: u64,
    pub total_entries: u64,
}

#[event]
pub struct V2RoundSettled {
    pub round_id: u64,
    pub winner: Pubkey,
    pub pool: u64,
    pub winner_amount: u64,
    pub yes_pool_amount: u64,
    pub treasury_amount: u64,
    pub rollover_out: u64,
}

#[event]
pub struct V2RoundExpired {
    pub round_id: u64,
    pub pool: u64,
    pub buyback_amount: u64,
    pub treasury_amount: u64,
    pub rollover_out: u64,
}

#[event]
pub struct V2ForceExpired {
    pub round_id: u64,
    pub pool: u64,
    pub buyback_amount: u64,
    pub treasury_amount: u64,
    pub rollover_out: u64,
    pub caller: Pubkey,
}

#[event]
pub struct V2EvidenceRecorded {
    pub round_id: u64,
    pub wallet: Pubkey,
    pub yes_count: u64,
    pub total_yes_answers: u64,
}

#[event]
pub struct V2EvidenceClaimed {
    pub round_id: u64,
    pub wallet: Pubkey,
    pub amount: u64,
    pub yes_count: u64,
}

#[event]
pub struct V2EvidenceSwept {
    pub round_id: u64,
    pub unclaimed_amount: u64,
}

#[event]
pub struct V2DonationMade {
    pub donor: Pubkey,
    pub amount: u64,
    pub new_rollover_balance: u64,
}
