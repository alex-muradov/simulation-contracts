use anchor_lang::prelude::*;

#[error_code]
pub enum TwoPillsError {
    #[msg("Unauthorized: caller is not the authority")]
    Unauthorized,
    #[msg("Round is not active")]
    RoundNotActive,
    #[msg("Round is not settled")]
    RoundNotSettled,
    #[msg("Invalid round ID: must be next sequential")]
    InvalidRoundId,
    #[msg("Invalid end time: must be in the future")]
    InvalidEndTime,
    #[msg("Invalid side: must be A or B")]
    InvalidSide,
    #[msg("Invalid deposit amount: must be 0.01, 0.03, or 0.05 SOL")]
    InvalidAmount,
    #[msg("Side locked: you already chose the other side this round")]
    SideLocked,
    #[msg("Max deposits reached for this round (255)")]
    MaxDepositsReached,
    #[msg("Not a winner: your side did not win")]
    NotWinner,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Already swept")]
    AlreadySwept,
    #[msg("Sweep window not elapsed: must wait 7 days after round ends")]
    SweepWindowNotElapsed,
    #[msg("Round has deposits: cannot expire")]
    RoundHasDeposits,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid winner: must be A or B")]
    InvalidWinner,
    #[msg("Round has not ended yet")]
    RoundNotEnded,
    #[msg("Round has ended: deposits no longer accepted")]
    RoundEnded,
    #[msg("Round has no deposits: use expire instead")]
    RoundHasNoDeposits,
    #[msg("Vault balance too low: would drop below rent-exempt minimum")]
    VaultInsolvent,
    #[msg("Round has no players on winning side")]
    NoPlayersOnWinningSide,
    #[msg("Position must be claimed before closing (winner side)")]
    MustClaimFirst,
}
