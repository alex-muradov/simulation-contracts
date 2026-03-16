/// Winner payout: 50% of pool
pub const BPS_WINNER: u64 = 5000;

/// Rollover: 30% of pool
pub const BPS_ROLLOVER: u64 = 3000;

/// YES pool: 15% of pool — distributed to evidence claimants
pub const BPS_YES_POOL: u64 = 1500;

/// Treasury fee: 5% of pool
pub const BPS_TREASURY: u64 = 500;

/// Expire buyback placeholder: 47.5% of deposits to buyback wallet
/// (temporarily routes to rollover during Phase 1)
pub const BPS_EXPIRE_BUYBACK: u64 = 4750;

/// Expire rollover: 47.5% of deposits to rollover
pub const BPS_EXPIRE_ROLLOVER: u64 = 4750;

/// Expire treasury: 5% of deposits
pub const BPS_EXPIRE_TREASURY: u64 = 500;

/// Total basis points (100%)
pub const BPS_TOTAL: u64 = 10000;

/// Base entry fee: 0.05 SOL in lamports
pub const BASE_ENTRY_FEE: u64 = 50_000_000;

/// Entry fee increment per price interval: 0.01 SOL in lamports
pub const ENTRY_FEE_INCREMENT: u64 = 10_000_000;

/// Price interval: 2 minutes in seconds
pub const PRICE_INTERVAL_SECS: i64 = 120;

/// Emergency grace period: 24 hours in seconds
pub const EMERGENCY_GRACE_SECS: i64 = 86_400;
