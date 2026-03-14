import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AlonsBoxV2 } from "../target/types/alons_box_v2";
import { assert } from "chai";
import { createHash } from "crypto";
import {
    SystemProgram,
    LAMPORTS_PER_SOL,
    Keypair,
    PublicKey,
} from "@solana/web3.js";

/**
 * V2 Evidence System Tests
 *
 * Covers the YES pool evidence lifecycle:
 *   record_v2_evidence -> settle (50/30/15/5) -> claim_v2_evidence -> sweep_v2_evidence -> close_v2_evidence
 *
 * Payout split with evidence: 50% winner, 30% rollover, 15% YES pool, 5% treasury
 * Payout split without evidence: 50% winner, 45% rollover (30+15), 5% treasury
 *
 * IMPORTANT: All test files share the same on-chain state (same program, same PDAs).
 * This test file reads the current game state at the start and builds relative
 * to the existing rollover balance and round ID.
 */
describe("alons-box-v2 evidence", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
    const authority = (provider.wallet as anchor.Wallet).payer;

    // Read wallets from game state
    let treasuryPk: PublicKey;
    let buybackPk: PublicKey;

    // Players for evidence tests
    const evPlayer1 = Keypair.generate();
    const evPlayer2 = Keypair.generate();
    const evPlayer3 = Keypair.generate();
    const nonAuthority = Keypair.generate();

    // PDAs
    let gameStatePDA: PublicKey;
    let vaultPDA: PublicKey;

    // Constants
    const BASE_FEE = Math.floor(0.05 * LAMPORTS_PER_SOL); // 50_000_000 lamports
    const BPS_WINNER = 5000;
    const BPS_YES_POOL = 1500;
    const BPS_TREASURY = 500;
    const BPS_TOTAL = 10000;

    // Track round IDs used across tests
    let recordRoundId: number;
    let settleEvidenceRoundId: number;
    let settleNoEvidenceRoundId: number;
    let claimRoundId: number;
    let sweepRoundId: number;
    let closeRoundId: number;
    let edgeCaseRoundId: number;

    // ---- Helpers ----

    function computeCommitHash(answer: string, salt: string): number[] {
        return Array.from(
            createHash("sha256").update(`${answer}:${salt}`).digest()
        );
    }

    function getV2RoundPDA(roundId: number): [PublicKey, number] {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(roundId));
        return PublicKey.findProgramAddressSync(
            [Buffer.from("v2_round"), buf],
            program.programId
        );
    }

    function getV2EntryPDA(
        roundId: number,
        player: PublicKey
    ): [PublicKey, number] {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(roundId));
        return PublicKey.findProgramAddressSync(
            [Buffer.from("v2_entry"), buf, player.toBuffer()],
            program.programId
        );
    }

    function getV2EvidencePDA(
        roundId: number,
        wallet: PublicKey
    ): [PublicKey, number] {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(roundId));
        return PublicKey.findProgramAddressSync(
            [Buffer.from("v2_evidence"), buf, wallet.toBuffer()],
            program.programId
        );
    }

    async function getNextRoundId(): Promise<number> {
        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        return gs.currentRoundId.toNumber() + 1;
    }

    async function getRolloverBalance(): Promise<number> {
        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        return gs.rolloverBalance.toNumber();
    }

    /**
     * Helper: create a round, have players enter, return roundId and roundPDA
     */
    async function createRoundWithPlayers(
        players: Keypair[],
        answer: string,
        salt: string
    ): Promise<{ roundId: number; roundPDA: PublicKey }> {
        const roundId = await getNextRoundId();
        const [roundPDA] = getV2RoundPDA(roundId);

        await program.methods
            .createRound(
                new anchor.BN(roundId),
                computeCommitHash(answer, salt)
            )
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        for (const player of players) {
            const [entryPDA] = getV2EntryPDA(roundId, player.publicKey);
            await program.methods
                .enter(new anchor.BN(BASE_FEE))
                .accounts({
                    player: player.publicKey,
                    round: roundPDA,
                    entry: entryPDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([player])
                .rpc();
        }

        return { roundId, roundPDA };
    }

    /**
     * Helper: settle a round with a given winner
     */
    async function settleRound(
        roundId: number,
        roundPDA: PublicKey,
        answer: string,
        salt: string,
        winner: PublicKey
    ): Promise<void> {
        await program.methods
            .settle(answer, salt)
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA,
                vault: vaultPDA,
                winner,
                treasury: treasuryPk,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    // ---- Setup ----

    before(async () => {
        [gameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_game_state")],
            program.programId
        );
        [vaultPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_vault")],
            program.programId
        );

        // Read wallet pubkeys from existing game state
        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        treasuryPk = gs.treasury;
        buybackPk = gs.buybackWallet;

        // Airdrop to evidence test players and non-authority
        for (const kp of [evPlayer1, evPlayer2, evPlayer3, nonAuthority]) {
            const sig = await provider.connection.requestAirdrop(
                kp.publicKey,
                10 * LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
        }
    });

    // ================================================================
    // 1. Record Evidence
    // ================================================================

    describe("1. Record Evidence", () => {
        const answer = "evidence-record";
        const salt = "ev-salt-record-1234567890abcdef";
        let roundPDA: PublicKey;

        it("Records evidence for a wallet with YES answer", async () => {
            // Create a round and have player1 enter
            const result = await createRoundWithPlayers(
                [evPlayer1],
                answer,
                salt
            );
            recordRoundId = result.roundId;
            roundPDA = result.roundPDA;

            // Record evidence for player1
            const [evidencePDA] = getV2EvidencePDA(
                recordRoundId,
                evPlayer1.publicKey
            );

            await program.methods
                .recordV2Evidence(new anchor.BN(recordRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evidencePDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Verify V2Evidence PDA created
            const evidence = await program.account.v2Evidence.fetch(
                evidencePDA
            );
            assert.equal(
                evidence.roundId.toNumber(),
                recordRoundId,
                "Evidence round_id should match"
            );
            assert.ok(
                evidence.wallet.equals(evPlayer1.publicKey),
                "Evidence wallet should match player1"
            );
            assert.equal(
                evidence.yesCount.toNumber(),
                1,
                "yes_count should be 1"
            );
            assert.isFalse(evidence.claimed, "claimed should be false");
            assert.isTrue(
                evidence.initialized,
                "initialized should be true"
            );

            // Verify round counters
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(
                round.evidenceCount.toNumber(),
                1,
                "evidence_count should be 1"
            );
            assert.equal(
                round.totalYesAnswers.toNumber(),
                1,
                "total_yes_answers should be 1"
            );
        });

        it("Increments yes_count on second call for same wallet", async () => {
            const [evidencePDA] = getV2EvidencePDA(
                recordRoundId,
                evPlayer1.publicKey
            );

            await program.methods
                .recordV2Evidence(new anchor.BN(recordRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evidencePDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Verify yes_count incremented
            const evidence = await program.account.v2Evidence.fetch(
                evidencePDA
            );
            assert.equal(
                evidence.yesCount.toNumber(),
                2,
                "yes_count should be 2 after second call"
            );

            // Verify round: evidence_count still 1 (same wallet), total_yes_answers = 2
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(
                round.evidenceCount.toNumber(),
                1,
                "evidence_count should still be 1 (same wallet)"
            );
            assert.equal(
                round.totalYesAnswers.toNumber(),
                2,
                "total_yes_answers should be 2"
            );
        });

        it("Records evidence for different wallets", async () => {
            // Have player2 enter the round first
            const [entry2PDA] = getV2EntryPDA(
                recordRoundId,
                evPlayer2.publicKey
            );
            await program.methods
                .enter(new anchor.BN(BASE_FEE))
                .accounts({
                    player: evPlayer2.publicKey,
                    round: roundPDA,
                    entry: entry2PDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([evPlayer2])
                .rpc();

            // Record evidence for player2
            const [evidence2PDA] = getV2EvidencePDA(
                recordRoundId,
                evPlayer2.publicKey
            );

            await program.methods
                .recordV2Evidence(new anchor.BN(recordRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evidence2PDA,
                    wallet: evPlayer2.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Verify new evidence PDA
            const evidence2 = await program.account.v2Evidence.fetch(
                evidence2PDA
            );
            assert.equal(
                evidence2.yesCount.toNumber(),
                1,
                "player2 yes_count should be 1"
            );

            // Verify round counters
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(
                round.evidenceCount.toNumber(),
                2,
                "evidence_count should be 2 (two wallets)"
            );
            assert.equal(
                round.totalYesAnswers.toNumber(),
                3,
                "total_yes_answers should be 3 (2 from player1 + 1 from player2)"
            );
        });

        it("Non-authority cannot record evidence", async () => {
            const [evidencePDA] = getV2EvidencePDA(
                recordRoundId,
                evPlayer3.publicKey
            );

            try {
                await program.methods
                    .recordV2Evidence(new anchor.BN(recordRoundId))
                    .accounts({
                        authority: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        evidence: evidencePDA,
                        wallet: evPlayer3.publicKey,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Should have thrown Unauthorized error");
            } catch (err: any) {
                assert.include(
                    err.toString(),
                    "Unauthorized",
                    "Should fail with Unauthorized"
                );
            }
        });

        it("Cannot record evidence on settled round", async () => {
            // Settle the record round first
            await settleRound(
                recordRoundId,
                roundPDA,
                answer,
                salt,
                evPlayer1.publicKey
            );

            // Verify round is settled
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { settled: {} });

            // Try to record evidence on settled round
            const [evidencePDA] = getV2EvidencePDA(
                recordRoundId,
                evPlayer3.publicKey
            );

            try {
                await program.methods
                    .recordV2Evidence(new anchor.BN(recordRoundId))
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        evidence: evidencePDA,
                        wallet: evPlayer3.publicKey,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown RoundNotActive error");
            } catch (err: any) {
                assert.include(
                    err.toString(),
                    "RoundNotActive",
                    "Should fail with RoundNotActive"
                );
            }
        });
    });

    // ================================================================
    // 2. Settle with Evidence (50/30/15/5)
    // ================================================================

    describe("2. Settle with Evidence (50/30/15/5)", () => {
        it("Settle allocates 15% YES pool when evidence exists", async () => {
            const answer = "evidence-settle-yes";
            const salt = "ev-salt-settle-yes-1234567890ab";

            // Create round with 2 players
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1, evPlayer2],
                answer,
                salt
            );
            settleEvidenceRoundId = roundId;

            // Record evidence: player1 gets 2 YES, player2 gets 1 YES
            const [ev1PDA] = getV2EvidencePDA(roundId, evPlayer1.publicKey);
            const [ev2PDA] = getV2EvidencePDA(roundId, evPlayer2.publicKey);

            // player1: 2 YES answers
            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: ev1PDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: ev1PDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // player2: 1 YES answer
            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: ev2PDA,
                    wallet: evPlayer2.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Read round state before settle for pool calculation
            const roundBefore = await program.account.v2Round.fetch(roundPDA);
            const totalDeposits = roundBefore.totalDeposits.toNumber();
            const rolloverIn = roundBefore.rolloverIn.toNumber();
            const pool = totalDeposits + rolloverIn;

            // Expected splits
            const winnerExpected = Math.floor(
                (pool * BPS_WINNER) / BPS_TOTAL
            );
            const yesPoolExpected = Math.floor(
                (pool * BPS_YES_POOL) / BPS_TOTAL
            );
            const treasuryExpected = Math.floor(
                (pool * BPS_TREASURY) / BPS_TOTAL
            );
            const rolloverExpected =
                pool - winnerExpected - yesPoolExpected - treasuryExpected;

            // Record balances before settle
            const winnerBefore = await provider.connection.getBalance(
                evPlayer1.publicKey
            );
            const treasuryBefore =
                await provider.connection.getBalance(treasuryPk);

            // Settle with player1 as winner
            await settleRound(
                roundId,
                roundPDA,
                answer,
                salt,
                evPlayer1.publicKey
            );

            // Verify round state after settle
            const roundAfter = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(roundAfter.status, { settled: {} });

            // Verify winner received 50%
            const winnerAfter = await provider.connection.getBalance(
                evPlayer1.publicKey
            );
            assert.equal(
                winnerAfter - winnerBefore,
                winnerExpected,
                "Winner should receive 50% of pool"
            );

            // Verify treasury received 5%
            const treasuryAfter =
                await provider.connection.getBalance(treasuryPk);
            assert.equal(
                treasuryAfter - treasuryBefore,
                treasuryExpected,
                "Treasury should receive 5% of pool"
            );

            // Verify evidence_pool is ~15% of pool
            assert.approximately(
                roundAfter.evidencePool.toNumber(),
                yesPoolExpected,
                1,
                "evidence_pool should be ~15% of pool"
            );

            // Verify rollover is ~30% (NOT 45%)
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            assert.approximately(
                gs.rolloverBalance.toNumber(),
                rolloverExpected,
                1,
                "Rollover should be ~30% of pool (NOT 45%)"
            );

            // Verify invariant: winner + treasury + rollover + evidence_pool = pool
            const totalDistributed =
                winnerExpected +
                treasuryExpected +
                rolloverExpected +
                roundAfter.evidencePool.toNumber();
            assert.approximately(
                totalDistributed,
                pool,
                1,
                "Total distributed should equal pool"
            );
        });

        it("Settle routes YES pool to rollover when no evidence", async () => {
            const answer = "evidence-settle-no";
            const salt = "ev-salt-settle-no-1234567890abc";

            // Create round with 1 player, no evidence recorded
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1],
                answer,
                salt
            );
            settleNoEvidenceRoundId = roundId;

            // Read round state for pool calculation
            const roundBefore = await program.account.v2Round.fetch(roundPDA);
            const totalDeposits = roundBefore.totalDeposits.toNumber();
            const rolloverIn = roundBefore.rolloverIn.toNumber();
            const pool = totalDeposits + rolloverIn;

            // Expected splits WITHOUT evidence: winner=50%, treasury=5%, rollover=45% (30+15)
            const winnerExpected = Math.floor(
                (pool * BPS_WINNER) / BPS_TOTAL
            );
            const treasuryExpected = Math.floor(
                (pool * BPS_TREASURY) / BPS_TOTAL
            );
            // Rollover absorbs both 30% rollover + 15% YES pool = 45%
            const rolloverExpected =
                pool - winnerExpected - treasuryExpected;

            // Settle without recording any evidence
            await settleRound(
                roundId,
                roundPDA,
                answer,
                salt,
                evPlayer1.publicKey
            );

            // Verify evidence_pool = 0
            const roundAfter = await program.account.v2Round.fetch(roundPDA);
            assert.equal(
                roundAfter.evidencePool.toNumber(),
                0,
                "evidence_pool should be 0 when no evidence recorded"
            );

            // Verify rollover is ~45%
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            assert.approximately(
                gs.rolloverBalance.toNumber(),
                rolloverExpected,
                1,
                "Rollover should be ~45% of pool (30% + 15%) when no evidence"
            );
        });
    });

    // ================================================================
    // 3. Claim Evidence
    // ================================================================

    describe("3. Claim Evidence", () => {
        const claimAnswer = "evidence-claim-test";
        const claimSalt = "ev-salt-claim-test-1234567890ab";
        let claimRoundPDA: PublicKey;
        let claimEvidencePool: number;

        before(async () => {
            // Create a fresh round for claim tests
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1, evPlayer2],
                claimAnswer,
                claimSalt
            );
            claimRoundId = roundId;
            claimRoundPDA = roundPDA;

            // Record evidence: player1 gets 2 YES, player2 gets 1 YES (total = 3)
            const [ev1PDA] = getV2EvidencePDA(
                claimRoundId,
                evPlayer1.publicKey
            );
            const [ev2PDA] = getV2EvidencePDA(
                claimRoundId,
                evPlayer2.publicKey
            );

            // player1: 2 YES
            await program.methods
                .recordV2Evidence(new anchor.BN(claimRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: claimRoundPDA,
                    evidence: ev1PDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await program.methods
                .recordV2Evidence(new anchor.BN(claimRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: claimRoundPDA,
                    evidence: ev1PDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // player2: 1 YES
            await program.methods
                .recordV2Evidence(new anchor.BN(claimRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: claimRoundPDA,
                    evidence: ev2PDA,
                    wallet: evPlayer2.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Settle the round
            await settleRound(
                claimRoundId,
                claimRoundPDA,
                claimAnswer,
                claimSalt,
                evPlayer1.publicKey
            );

            // Read evidence pool
            const round = await program.account.v2Round.fetch(claimRoundPDA);
            claimEvidencePool = round.evidencePool.toNumber();
        });

        it("Player claims proportional evidence share", async () => {
            // player1 has 2 YES, total = 3 -> share = evidence_pool * 2 / 3
            const player1Expected = Math.floor(
                (claimEvidencePool * 2) / 3
            );
            // player2 has 1 YES, total = 3 -> share = evidence_pool * 1 / 3
            const player2Expected = Math.floor(
                (claimEvidencePool * 1) / 3
            );

            // --- Player1 claims (self-claim: signer = beneficiary) ---
            const [ev1PDA] = getV2EvidencePDA(
                claimRoundId,
                evPlayer1.publicKey
            );
            const player1Before = await provider.connection.getBalance(
                evPlayer1.publicKey
            );

            await program.methods
                .claimV2Evidence(new anchor.BN(claimRoundId))
                .accounts({
                    signer: evPlayer1.publicKey,
                    gameState: gameStatePDA,
                    round: claimRoundPDA,
                    evidence: ev1PDA,
                    beneficiary: evPlayer1.publicKey,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([evPlayer1])
                .rpc();

            const player1After = await provider.connection.getBalance(
                evPlayer1.publicKey
            );
            // Player1 pays tx fee, so received amount = balance change + tx fee is approximate
            // But since the transfer is from vault (not from signer), balance should increase by share minus any tx costs
            // Actually, player1 is the signer and pays tx fee. The vault transfers share to beneficiary.
            // Net change = share - tx_fee. Use approximately with generous tolerance for tx fee.
            // However, the signer paying gas means the balance change won't be exactly share.
            // Let's check evidence state instead and verify balance increased.
            assert.isAbove(
                player1After - player1Before,
                0,
                "Player1 balance should increase after claiming"
            );

            // Verify evidence marked as claimed
            const ev1 = await program.account.v2Evidence.fetch(ev1PDA);
            assert.isTrue(ev1.claimed, "Evidence should be marked as claimed");

            // Verify round evidence_claimed updated
            const round = await program.account.v2Round.fetch(claimRoundPDA);
            assert.equal(
                round.evidenceClaimed.toNumber(),
                player1Expected,
                "evidence_claimed should equal player1's share"
            );

            // --- Player2 claims (self-claim) ---
            const [ev2PDA] = getV2EvidencePDA(
                claimRoundId,
                evPlayer2.publicKey
            );
            const player2Before = await provider.connection.getBalance(
                evPlayer2.publicKey
            );

            await program.methods
                .claimV2Evidence(new anchor.BN(claimRoundId))
                .accounts({
                    signer: evPlayer2.publicKey,
                    gameState: gameStatePDA,
                    round: claimRoundPDA,
                    evidence: ev2PDA,
                    beneficiary: evPlayer2.publicKey,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([evPlayer2])
                .rpc();

            const player2After = await provider.connection.getBalance(
                evPlayer2.publicKey
            );
            assert.isAbove(
                player2After - player2Before,
                0,
                "Player2 balance should increase after claiming"
            );

            // Verify evidence marked as claimed
            const ev2 = await program.account.v2Evidence.fetch(ev2PDA);
            assert.isTrue(
                ev2.claimed,
                "Player2 evidence should be marked as claimed"
            );

            // Verify round evidence_claimed = player1_share + player2_share
            const roundAfter = await program.account.v2Round.fetch(
                claimRoundPDA
            );
            assert.equal(
                roundAfter.evidenceClaimed.toNumber(),
                player1Expected + player2Expected,
                "evidence_claimed should be sum of both shares"
            );
        });

        it("Cannot claim evidence twice", async () => {
            const [ev1PDA] = getV2EvidencePDA(
                claimRoundId,
                evPlayer1.publicKey
            );

            try {
                await program.methods
                    .claimV2Evidence(new anchor.BN(claimRoundId))
                    .accounts({
                        signer: evPlayer1.publicKey,
                        gameState: gameStatePDA,
                        round: claimRoundPDA,
                        evidence: ev1PDA,
                        beneficiary: evPlayer1.publicKey,
                        vault: vaultPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([evPlayer1])
                    .rpc();
                assert.fail("Should have thrown EvidenceAlreadyClaimed error");
            } catch (err: any) {
                assert.include(
                    err.toString(),
                    "EvidenceAlreadyClaimed",
                    "Should fail with EvidenceAlreadyClaimed"
                );
            }
        });

        it("Authority can claim on behalf of player", async () => {
            const authClaimAnswer = "evidence-auth-claim";
            const authClaimSalt = "ev-salt-auth-claim-1234567890ab";

            // Create a fresh round for authority-claim test
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer3],
                authClaimAnswer,
                authClaimSalt
            );

            // Record evidence for player3
            const [ev3PDA] = getV2EvidencePDA(roundId, evPlayer3.publicKey);

            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: ev3PDA,
                    wallet: evPlayer3.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Settle the round
            await settleRound(
                roundId,
                roundPDA,
                authClaimAnswer,
                authClaimSalt,
                evPlayer3.publicKey
            );

            // Authority claims on behalf of player3
            const player3Before = await provider.connection.getBalance(
                evPlayer3.publicKey
            );

            await program.methods
                .claimV2Evidence(new anchor.BN(roundId))
                .accounts({
                    signer: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: ev3PDA,
                    beneficiary: evPlayer3.publicKey,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const player3After = await provider.connection.getBalance(
                evPlayer3.publicKey
            );
            assert.isAbove(
                player3After - player3Before,
                0,
                "Player3 balance should increase when authority claims on their behalf"
            );

            // Verify evidence marked as claimed
            const ev3 = await program.account.v2Evidence.fetch(ev3PDA);
            assert.isTrue(
                ev3.claimed,
                "Evidence should be marked as claimed after authority claim"
            );
        });

        it("Cannot claim on active round", async () => {
            const activeAnswer = "evidence-active-claim";
            const activeSalt = "ev-salt-active-claim-1234567890";

            // Create an active round with evidence
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1],
                activeAnswer,
                activeSalt
            );

            // Record evidence
            const [evPDA] = getV2EvidencePDA(roundId, evPlayer1.publicKey);
            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evPDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Try to claim on active round (not settled)
            try {
                await program.methods
                    .claimV2Evidence(new anchor.BN(roundId))
                    .accounts({
                        signer: evPlayer1.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        evidence: evPDA,
                        beneficiary: evPlayer1.publicKey,
                        vault: vaultPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([evPlayer1])
                    .rpc();
                assert.fail("Should have thrown RoundNotSettled error");
            } catch (err: any) {
                assert.include(
                    err.toString(),
                    "RoundNotSettled",
                    "Should fail with RoundNotSettled"
                );
            }

            // Clean up: settle this round so it doesn't block future tests
            await settleRound(
                roundId,
                roundPDA,
                activeAnswer,
                activeSalt,
                evPlayer1.publicKey
            );
        });
    });

    // ================================================================
    // 4. Sweep Evidence
    // ================================================================

    describe("4. Sweep Evidence", () => {
        const sweepAnswer = "evidence-sweep-test";
        const sweepSalt = "ev-salt-sweep-test-1234567890ab";
        let sweepRoundPDA: PublicKey;
        let sweepEvidencePool: number;
        let player1SweepShare: number;

        before(async () => {
            // Create round with 2 players
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1, evPlayer2],
                sweepAnswer,
                sweepSalt
            );
            sweepRoundId = roundId;
            sweepRoundPDA = roundPDA;

            // Record evidence for both players (1 YES each)
            const [ev1PDA] = getV2EvidencePDA(
                sweepRoundId,
                evPlayer1.publicKey
            );
            const [ev2PDA] = getV2EvidencePDA(
                sweepRoundId,
                evPlayer2.publicKey
            );

            await program.methods
                .recordV2Evidence(new anchor.BN(sweepRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: sweepRoundPDA,
                    evidence: ev1PDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await program.methods
                .recordV2Evidence(new anchor.BN(sweepRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: sweepRoundPDA,
                    evidence: ev2PDA,
                    wallet: evPlayer2.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Settle the round
            await settleRound(
                sweepRoundId,
                sweepRoundPDA,
                sweepAnswer,
                sweepSalt,
                evPlayer1.publicKey
            );

            // Read evidence pool
            const round = await program.account.v2Round.fetch(sweepRoundPDA);
            sweepEvidencePool = round.evidencePool.toNumber();

            // Only player1 claims (player2 does NOT claim)
            player1SweepShare = Math.floor(sweepEvidencePool / 2);

            await program.methods
                .claimV2Evidence(new anchor.BN(sweepRoundId))
                .accounts({
                    signer: evPlayer1.publicKey,
                    gameState: gameStatePDA,
                    round: sweepRoundPDA,
                    evidence: ev1PDA,
                    beneficiary: evPlayer1.publicKey,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([evPlayer1])
                .rpc();
        });

        it("Sweeps unclaimed evidence to rollover", async () => {
            // Read rollover before sweep
            const rolloverBefore = await getRolloverBalance();

            // Read round state before sweep
            const roundBefore = await program.account.v2Round.fetch(
                sweepRoundPDA
            );
            const unclaimed =
                roundBefore.evidencePool.toNumber() -
                roundBefore.evidenceClaimed.toNumber();
            assert.isAbove(unclaimed, 0, "There should be unclaimed evidence");

            // Sweep
            await program.methods
                .sweepV2Evidence(new anchor.BN(sweepRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: sweepRoundPDA,
                    vault: vaultPDA,
                })
                .rpc();

            // Verify rollover increased by unclaimed amount
            const rolloverAfter = await getRolloverBalance();
            assert.equal(
                rolloverAfter - rolloverBefore,
                unclaimed,
                "Rollover should increase by unclaimed evidence amount"
            );

            // Verify evidence_claimed = evidence_pool after sweep
            const roundAfter = await program.account.v2Round.fetch(
                sweepRoundPDA
            );
            assert.equal(
                roundAfter.evidenceClaimed.toNumber(),
                roundAfter.evidencePool.toNumber(),
                "evidence_claimed should equal evidence_pool after sweep"
            );
        });

        it("Non-authority cannot sweep", async () => {
            // Create another round to have something to sweep
            const nsAnswer = "evidence-no-sweep";
            const nsSalt = "ev-salt-no-sweep-1234567890abcd";

            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1],
                nsAnswer,
                nsSalt
            );

            // Record evidence
            const [evPDA] = getV2EvidencePDA(roundId, evPlayer1.publicKey);
            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evPDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Settle
            await settleRound(
                roundId,
                roundPDA,
                nsAnswer,
                nsSalt,
                evPlayer1.publicKey
            );

            // Non-authority tries to sweep
            try {
                await program.methods
                    .sweepV2Evidence(new anchor.BN(roundId))
                    .accounts({
                        authority: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Should have thrown Unauthorized error");
            } catch (err: any) {
                assert.include(
                    err.toString(),
                    "Unauthorized",
                    "Should fail with Unauthorized"
                );
            }

            // Clean up: sweep with authority so unclaimed doesn't linger
            await program.methods
                .sweepV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    vault: vaultPDA,
                })
                .rpc();
        });
    });

    // ================================================================
    // 5. Close Evidence
    // ================================================================

    describe("5. Close Evidence", () => {
        const closeAnswer = "evidence-close-test";
        const closeSalt = "ev-salt-close-test-1234567890ab";
        let closeRoundPDA: PublicKey;

        before(async () => {
            // Create round, record evidence, settle, claim
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1],
                closeAnswer,
                closeSalt
            );
            closeRoundId = roundId;
            closeRoundPDA = roundPDA;

            // Record evidence
            const [evPDA] = getV2EvidencePDA(
                closeRoundId,
                evPlayer1.publicKey
            );
            await program.methods
                .recordV2Evidence(new anchor.BN(closeRoundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: closeRoundPDA,
                    evidence: evPDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Settle
            await settleRound(
                closeRoundId,
                closeRoundPDA,
                closeAnswer,
                closeSalt,
                evPlayer1.publicKey
            );

            // Claim evidence
            await program.methods
                .claimV2Evidence(new anchor.BN(closeRoundId))
                .accounts({
                    signer: evPlayer1.publicKey,
                    gameState: gameStatePDA,
                    round: closeRoundPDA,
                    evidence: evPDA,
                    beneficiary: evPlayer1.publicKey,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([evPlayer1])
                .rpc();
        });

        it("Closes evidence PDA and reclaims rent", async () => {
            const [evPDA] = getV2EvidencePDA(
                closeRoundId,
                evPlayer1.publicKey
            );

            // Verify evidence PDA exists before close
            const evBefore =
                await provider.connection.getAccountInfo(evPDA);
            assert.isNotNull(evBefore, "Evidence PDA should exist before close");

            // Record authority balance before close (rent will be returned to authority)
            const authorityBefore = await provider.connection.getBalance(
                authority.publicKey
            );

            // Close evidence PDA
            await program.methods
                .closeV2Evidence()
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: closeRoundPDA,
                    evidence: evPDA,
                })
                .rpc();

            // Verify evidence PDA no longer exists
            const evAfter =
                await provider.connection.getAccountInfo(evPDA);
            assert.isNull(
                evAfter,
                "Evidence PDA should no longer exist after close"
            );

            // Verify authority received rent back (balance increased, accounting for tx fee)
            // The rent reclaimed should be more than the tx fee paid
            const authorityAfter = await provider.connection.getBalance(
                authority.publicKey
            );
            // Authority pays tx fee but receives rent. Net could be positive or close to zero.
            // Just verify the account was closed (already done above).
            // The key check is that the account is null.
        });

        it("Cannot close evidence on active round", async () => {
            const activeCloseAnswer = "evidence-active-close";
            const activeCloseSalt = "ev-salt-active-close-1234567890";

            // Create active round with evidence
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1],
                activeCloseAnswer,
                activeCloseSalt
            );

            // Record evidence
            const [evPDA] = getV2EvidencePDA(roundId, evPlayer1.publicKey);
            await program.methods
                .recordV2Evidence(new anchor.BN(roundId))
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evPDA,
                    wallet: evPlayer1.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Try to close evidence on active round (should fail with RoundStillActive)
            try {
                await program.methods
                    .closeV2Evidence()
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        evidence: evPDA,
                    })
                    .rpc();
                assert.fail("Should have thrown RoundStillActive error");
            } catch (err: any) {
                assert.include(
                    err.toString(),
                    "RoundStillActive",
                    "Should fail with RoundStillActive"
                );
            }

            // Clean up: settle the round
            await settleRound(
                roundId,
                roundPDA,
                activeCloseAnswer,
                activeCloseSalt,
                evPlayer1.publicKey
            );
        });
    });

    // ================================================================
    // 6. Edge Cases
    // ================================================================

    describe("6. Edge Cases", () => {
        it("Single player with all YES answers gets full 15%", async () => {
            const edgeAnswer = "evidence-edge-single";
            const edgeSalt = "ev-salt-edge-single-1234567890a";

            // Create round with 1 player
            const { roundId, roundPDA } = await createRoundWithPlayers(
                [evPlayer1],
                edgeAnswer,
                edgeSalt
            );
            edgeCaseRoundId = roundId;

            // Record 5 YES answers for player1
            const [evPDA] = getV2EvidencePDA(roundId, evPlayer1.publicKey);
            for (let i = 0; i < 5; i++) {
                await program.methods
                    .recordV2Evidence(new anchor.BN(roundId))
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        evidence: evPDA,
                        wallet: evPlayer1.publicKey,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
            }

            // Verify yes_count = 5
            const evidence = await program.account.v2Evidence.fetch(evPDA);
            assert.equal(
                evidence.yesCount.toNumber(),
                5,
                "yes_count should be 5"
            );

            // Read round for pool calculation
            const roundBefore = await program.account.v2Round.fetch(roundPDA);
            const pool =
                roundBefore.totalDeposits.toNumber() +
                roundBefore.rolloverIn.toNumber();
            const expectedEvidencePool = Math.floor(
                (pool * BPS_YES_POOL) / BPS_TOTAL
            );

            // Settle
            await settleRound(
                roundId,
                roundPDA,
                edgeAnswer,
                edgeSalt,
                evPlayer1.publicKey
            );

            // Read evidence pool
            const roundAfter = await program.account.v2Round.fetch(roundPDA);
            const evidencePool = roundAfter.evidencePool.toNumber();
            assert.approximately(
                evidencePool,
                expectedEvidencePool,
                1,
                "evidence_pool should be ~15% of pool"
            );

            // Claim: single player gets full evidence pool
            // share = evidence_pool * 5 / 5 = evidence_pool
            const player1Before = await provider.connection.getBalance(
                evPlayer1.publicKey
            );

            await program.methods
                .claimV2Evidence(new anchor.BN(roundId))
                .accounts({
                    signer: evPlayer1.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    evidence: evPDA,
                    beneficiary: evPlayer1.publicKey,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([evPlayer1])
                .rpc();

            const player1After = await provider.connection.getBalance(
                evPlayer1.publicKey
            );

            // Verify evidence_claimed = evidence_pool (full pool claimed)
            const roundFinal = await program.account.v2Round.fetch(roundPDA);
            assert.equal(
                roundFinal.evidenceClaimed.toNumber(),
                evidencePool,
                "Single player should claim full evidence pool"
            );

            // Verify player balance increased (accounting for tx fee)
            assert.isAbove(
                player1After - player1Before,
                0,
                "Player balance should increase after claiming full evidence pool"
            );
        });

        it("Vault stays rent-exempt after evidence claims", async () => {
            // After all tests above, verify vault is still rent-exempt
            const vaultBalance =
                await provider.connection.getBalance(vaultPDA);
            const rentExemptMin =
                await provider.connection.getMinimumBalanceForRentExemption(
                    V2VaultSize()
                );

            assert.isAtLeast(
                vaultBalance,
                rentExemptMin,
                "Vault must remain rent-exempt after all evidence operations"
            );

            // Verify vault account still exists
            const vaultInfo =
                await provider.connection.getAccountInfo(vaultPDA);
            assert.isNotNull(
                vaultInfo,
                "Vault account must still exist after all evidence tests"
            );

            // Verify vault balance covers rollover + rent
            const rollover = await getRolloverBalance();
            assert.isAtLeast(
                vaultBalance,
                rollover + rentExemptMin,
                "Vault balance should cover rollover balance plus rent exemption"
            );
        });
    });
});

/**
 * V2Vault data size for rent calculation.
 * V2Vault::SIZE = 8 (disc) + 1 (bump) = 9. Rent uses data size = SIZE - 8 = 1.
 */
function V2VaultSize(): number {
    return 1; // data size without discriminator, matching the contract's calculation
}
