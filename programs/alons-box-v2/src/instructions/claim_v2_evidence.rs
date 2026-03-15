use anchor_lang::prelude::*;
use anchor_lang::solana_program::rent::Rent;
use crate::errors::V2Error;
use crate::events::V2EvidenceClaimed;
use crate::state::*;
use crate::utils::transfer_from_vault;

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct ClaimV2Evidence<'info> {
    /// Signer: either the evidence wallet (self-claim) or the authority (release on behalf)
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        mut,
        seeds = [b"v2_round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == V2RoundStatus::Settled @ V2Error::RoundNotSettled,
    )]
    pub round: Account<'info, V2Round>,

    #[account(
        mut,
        seeds = [b"v2_evidence", round_id.to_le_bytes().as_ref(), beneficiary.key().as_ref()],
        bump = evidence.bump,
        constraint = evidence.initialized @ V2Error::EvidenceNotFound,
        constraint = !evidence.claimed @ V2Error::EvidenceAlreadyClaimed,
        constraint = evidence.wallet == beneficiary.key() @ V2Error::Unauthorized,
    )]
    pub evidence: Account<'info, V2Evidence>,

    /// CHECK: The wallet that receives the evidence payout. Must match evidence.wallet.
    #[account(mut)]
    pub beneficiary: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"v2_vault"],
        bump = vault.bump,
    )]
    pub vault: Account<'info, V2Vault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimV2Evidence>, _round_id: u64) -> Result<()> {
    let signer = &ctx.accounts.signer;
    let beneficiary = &ctx.accounts.beneficiary;
    let game_state = &ctx.accounts.game_state;

    // Authorization: signer must be either the beneficiary (self-claim) or the authority (release)
    require!(
        signer.key() == beneficiary.key() || signer.key() == game_state.authority,
        V2Error::Unauthorized
    );

    let round = &mut ctx.accounts.round;
    let evidence = &mut ctx.accounts.evidence;

    // Calculate this wallet's share: evidence_pool * yes_count / total_yes_answers
    require!(round.total_yes_answers > 0, V2Error::NoEvidence);

    let share = round.evidence_pool
        .checked_mul(evidence.yes_count)
        .ok_or(V2Error::MathOverflow)?
        .checked_div(round.total_yes_answers)
        .ok_or(V2Error::MathOverflow)?;

    require!(share > 0, V2Error::NothingToClaim);

    // Rent-exempt safety check on vault after transfer
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent = Rent::get()?;
    let rent_exempt_min = rent.minimum_balance(V2Vault::SIZE - 8);
    let post_balance = vault_info.lamports()
        .checked_sub(share)
        .ok_or(V2Error::VaultInsolvent)?;
    require!(post_balance >= rent_exempt_min, V2Error::VaultInsolvent);

    // Transfer from vault to beneficiary
    transfer_from_vault(
        &vault_info,
        &ctx.accounts.beneficiary,
        share,
    )?;

    // Mark as claimed
    evidence.claimed = true;

    // Track total claimed
    round.evidence_claimed = round.evidence_claimed
        .checked_add(share)
        .ok_or(V2Error::MathOverflow)?;

    emit!(V2EvidenceClaimed {
        round_id: round.round_id,
        wallet: evidence.wallet,
        amount: share,
        yes_count: evidence.yes_count,
    });

    Ok(())
}
