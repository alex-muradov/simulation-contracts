use anchor_lang::prelude::*;

#[error_code]
pub enum V2Error {
    #[msg("Unauthorized: caller is not the authority")]
    Unauthorized,
    #[msg("Round is not active")]
    RoundNotActive,
    #[msg("Invalid commit hash: SHA-256 mismatch")]
    InvalidCommitHash,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Entry period has closed")]
    EntryClosed,
    #[msg("Insufficient entry fee")]
    InsufficientEntryFee,
    #[msg("Answer too long (max 64 bytes)")]
    AnswerTooLong,
    #[msg("Salt too long (max 64 bytes)")]
    SaltTooLong,
    #[msg("Invalid round ID")]
    InvalidRoundId,
    #[msg("Round is still active")]
    RoundStillActive,
    #[msg("Emergency grace period has not elapsed")]
    GracePeriodNotElapsed,
    #[msg("Invalid end time")]
    InvalidEndTime,
    #[msg("Vault is insolvent")]
    VaultInsolvent,
    #[msg("Evidence PDA not found")]
    EvidenceNotFound,
    #[msg("Evidence already claimed")]
    EvidenceAlreadyClaimed,
    #[msg("No evidence recorded for this round")]
    NoEvidence,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Round not settled")]
    RoundNotSettled,
    #[msg("Invalid round duration")]
    InvalidRoundDuration,
    #[msg("Invalid entry cutoff")]
    InvalidEntryCutoff,
}
