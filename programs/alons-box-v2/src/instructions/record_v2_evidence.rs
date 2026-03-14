use anchor_lang::prelude::*;
use crate::errors::V2Error;
use crate::events::V2EvidenceRecorded;
use crate::state::*;

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RecordV2Evidence<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"v2_game_state"],
        bump = game_state.bump,
        constraint = game_state.authority == authority.key() @ V2Error::Unauthorized,
    )]
    pub game_state: Account<'info, V2GameState>,

    #[account(
        mut,
        seeds = [b"v2_round", round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        constraint = round.status == V2RoundStatus::Active @ V2Error::RoundNotActive,
    )]
    pub round: Account<'info, V2Round>,

    #[account(
        init_if_needed,
        payer = authority,
        space = V2Evidence::SIZE,
        seeds = [b"v2_evidence", round_id.to_le_bytes().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub evidence: Account<'info, V2Evidence>,

    /// CHECK: The wallet that asked the YES question (not a signer, just used for PDA derivation)
    pub wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RecordV2Evidence>, round_id: u64) -> Result<()> {
    let evidence = &mut ctx.accounts.evidence;
    let round = &mut ctx.accounts.round;

    if !evidence.initialized {
        // First YES answer for this wallet in this round
        evidence.round_id = round_id;
        evidence.wallet = ctx.accounts.wallet.key();
        evidence.yes_count = 1;
        evidence.claimed = false;
        evidence.initialized = true;
        evidence.bump = ctx.bumps.evidence;

        round.evidence_count = round.evidence_count
            .checked_add(1)
            .ok_or(V2Error::MathOverflow)?;
    } else {
        // Subsequent YES answer for the same wallet
        evidence.yes_count = evidence.yes_count
            .checked_add(1)
            .ok_or(V2Error::MathOverflow)?;
    }

    // Always increment total_yes_answers
    round.total_yes_answers = round.total_yes_answers
        .checked_add(1)
        .ok_or(V2Error::MathOverflow)?;

    emit!(V2EvidenceRecorded {
        round_id,
        wallet: ctx.accounts.wallet.key(),
        yes_count: evidence.yes_count,
        total_yes_answers: round.total_yes_answers,
    });

    Ok(())
}
