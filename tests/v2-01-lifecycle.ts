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
 * V2 Lifecycle Tests
 *
 * Covers: CNTR-01, CNTR-05, CNTR-06, CNTR-07, CNTR-09, CNTR-10, CNTR-13
 *
 * Tests the full round lifecycle:
 *   initialize -> create_round -> enter -> settle (winner flow)
 *   create_round -> enter -> expire (no-winner flow with buyback wallet)
 *   PDA namespace isolation (v2_ prefix vs v1)
 */
describe("alons-box-v2 lifecycle", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
    const authority = (provider.wallet as anchor.Wallet).payer;

    // Wallets
    const treasuryKeypair = Keypair.generate();
    const buybackKeypair = Keypair.generate();

    // Players
    const player1 = Keypair.generate();
    const player2 = Keypair.generate();
    const player3 = Keypair.generate();

    // PDAs
    let gameStatePDA: PublicKey;
    let vaultPDA: PublicKey;

    // Constants
    const ROUND_DURATION = 1200; // 20 min
    const ENTRY_CUTOFF = 180; // 3 min
    const BASE_FEE = Math.floor(0.05 * LAMPORTS_PER_SOL); // 50_000_000 lamports

    // ---- Helpers ----

    function computeCommitHash(answer: string, salt: string): number[] {
        const hash = createHash("sha256")
            .update(`${answer}:${salt}`)
            .digest();
        return Array.from(hash);
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

    // ---- Setup ----

    before(async () => {
        // Derive V2 PDAs
        [gameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_game_state")],
            program.programId
        );
        [vaultPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_vault")],
            program.programId
        );

        // Airdrop to players and wallets
        for (const kp of [
            player1,
            player2,
            player3,
            treasuryKeypair,
            buybackKeypair,
        ]) {
            const sig = await provider.connection.requestAirdrop(
                kp.publicKey,
                10 * LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
        }
    });

    // ---- Tests (sequential, each builds on prior state) ----

    it("Initializes V2 game state (CNTR-13)", async () => {
        await program.methods
            .initialize(
                treasuryKeypair.publicKey,
                buybackKeypair.publicKey,
                new anchor.BN(ROUND_DURATION),
                new anchor.BN(ENTRY_CUTOFF)
            )
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        assert.ok(gs.authority.equals(authority.publicKey));
        assert.ok(gs.treasury.equals(treasuryKeypair.publicKey));
        assert.ok(gs.buybackWallet.equals(buybackKeypair.publicKey));
        assert.equal(gs.currentRoundId.toNumber(), 0);
        assert.equal(gs.rolloverBalance.toNumber(), 0);
        assert.equal(gs.roundDurationSecs.toNumber(), ROUND_DURATION);
        assert.equal(gs.entryCutoffSecs.toNumber(), ENTRY_CUTOFF);
    });

    // ---- Round 1: settle flow ----

    describe("Round 1 -- settle flow", () => {
        const answer = "red apple";
        const salt = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
        const commitHash = computeCommitHash(answer, salt);
        let roundPDA: PublicKey;

        it("Creates a round with on-chain timer (CNTR-01)", async () => {
            [roundPDA] = getV2RoundPDA(1);

            await program.methods
                .createRound(new anchor.BN(1), commitHash)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.roundId.toNumber(), 1);
            assert.deepEqual(round.commitHash, commitHash);
            assert.deepEqual(round.status, { active: {} });
            assert.equal(round.totalDeposits.toNumber(), 0);
            assert.equal(round.totalEntries.toNumber(), 0);
            assert.equal(round.rolloverIn.toNumber(), 0);

            // Verify on-chain timer fields
            const now = Math.floor(Date.now() / 1000);
            assert.approximately(
                round.startedAt.toNumber(),
                now,
                5,
                "started_at should be within 5s of now"
            );
            assert.equal(
                round.endsAt.toNumber(),
                round.startedAt.toNumber() + ROUND_DURATION
            );
            assert.equal(
                round.entryCutoff.toNumber(),
                round.endsAt.toNumber() - ENTRY_CUTOFF
            );
        });

        it("Player enters at base fee (CNTR-03 partial)", async () => {
            const [entryPDA] = getV2EntryPDA(1, player1.publicKey);
            const vaultBefore = await provider.connection.getBalance(vaultPDA);

            await program.methods
                .enter(new anchor.BN(BASE_FEE))
                .accounts({
                    player: player1.publicKey,
                    round: roundPDA,
                    entry: entryPDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([player1])
                .rpc();

            // Verify entry
            const entry = await program.account.v2Entry.fetch(entryPDA);
            assert.ok(entry.player.equals(player1.publicKey));
            assert.equal(entry.amountPaid.toNumber(), BASE_FEE);
            assert.isAbove(entry.enteredAt.toNumber(), 0);

            // Verify round totals
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.totalEntries.toNumber(), 1);
            assert.equal(round.totalDeposits.toNumber(), BASE_FEE);

            // Verify vault balance increased
            const vaultAfter = await provider.connection.getBalance(vaultPDA);
            assert.equal(vaultAfter - vaultBefore, BASE_FEE);
        });

        it("Settles round with correct payout split (CNTR-05, CNTR-06, CNTR-07, CNTR-09)", async () => {
            // Player2 also enters round 1
            const [entry2PDA] = getV2EntryPDA(1, player2.publicKey);
            await program.methods
                .enter(new anchor.BN(BASE_FEE))
                .accounts({
                    player: player2.publicKey,
                    round: roundPDA,
                    entry: entry2PDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([player2])
                .rpc();

            // Read round state for pool calculation
            const round = await program.account.v2Round.fetch(roundPDA);
            const totalDeposits = round.totalDeposits.toNumber();
            const rolloverIn = round.rolloverIn.toNumber();
            const pool = totalDeposits + rolloverIn;

            // Expected splits (BPS: 5000 winner, 500 treasury, remainder rollover)
            const winnerExpected = Math.floor((pool * 5000) / 10000);
            const treasuryExpected = Math.floor((pool * 500) / 10000);
            const rolloverExpected = pool - winnerExpected - treasuryExpected;

            // Record balances before settlement
            const winnerBefore = await provider.connection.getBalance(
                player1.publicKey
            );
            const treasuryBefore = await provider.connection.getBalance(
                treasuryKeypair.publicKey
            );

            // Settle with player1 as winner
            await program.methods
                .settle(answer, salt)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    vault: vaultPDA,
                    winner: player1.publicKey,
                    treasury: treasuryKeypair.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Verify round status
            const settled = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(settled.status, { settled: {} });
            assert.equal(settled.revealedAnswer, answer);
            assert.equal(settled.revealedSalt, salt);

            // Verify balance changes
            const winnerAfter = await provider.connection.getBalance(
                player1.publicKey
            );
            const treasuryAfter = await provider.connection.getBalance(
                treasuryKeypair.publicKey
            );

            assert.equal(
                winnerAfter - winnerBefore,
                winnerExpected,
                "Winner should receive 50% of pool"
            );
            assert.equal(
                treasuryAfter - treasuryBefore,
                treasuryExpected,
                "Treasury should receive 5% of pool"
            );

            // Verify rollover in game state (45% = 30% rollover + 15% YES placeholder)
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            assert.equal(
                gs.rolloverBalance.toNumber(),
                rolloverExpected,
                "Rollover should be ~45% of pool (30% rollover + 15% YES placeholder)"
            );
        });
    });

    // ---- Round 2: expire flow ----

    describe("Round 2 -- expire flow with buyback wallet (CNTR-10)", () => {
        const answer = "blue chair";
        const salt = "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6";
        const commitHash = computeCommitHash(answer, salt);
        let roundPDA: PublicKey;

        it("Creates round 2 with rollover from round 1", async () => {
            [roundPDA] = getV2RoundPDA(2);

            await program.methods
                .createRound(new anchor.BN(2), commitHash)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.roundId.toNumber(), 2);
            // Should carry rollover from round 1
            assert.isAbove(
                round.rolloverIn.toNumber(),
                0,
                "Round 2 should have rollover from round 1"
            );
        });

        it("Expires round with no winner -- buyback wallet receives 47.5% (CNTR-10)", async () => {
            // Player3 enters round 2
            const [entry3PDA] = getV2EntryPDA(2, player3.publicKey);
            await program.methods
                .enter(new anchor.BN(BASE_FEE))
                .accounts({
                    player: player3.publicKey,
                    round: roundPDA,
                    entry: entry3PDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([player3])
                .rpc();

            // Read state before expiry
            const round = await program.account.v2Round.fetch(roundPDA);
            const totalDeposits = round.totalDeposits.toNumber();
            const rolloverIn = round.rolloverIn.toNumber();

            // Expected splits from deposits only (BPS: 4750 buyback, 500 treasury, remainder rollover)
            const buybackExpected = Math.floor(
                (totalDeposits * 4750) / 10000
            );
            const treasuryExpected = Math.floor(
                (totalDeposits * 500) / 10000
            );
            const rolloverAdded =
                totalDeposits - buybackExpected - treasuryExpected;
            const rolloverOutExpected = rolloverIn + rolloverAdded;

            // Record balances before
            const buybackBefore = await provider.connection.getBalance(
                buybackKeypair.publicKey
            );
            const treasuryBefore = await provider.connection.getBalance(
                treasuryKeypair.publicKey
            );

            // Expire round with buyback wallet account
            await program.methods
                .expire(answer, salt)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    vault: vaultPDA,
                    buybackWallet: buybackKeypair.publicKey,
                    treasury: treasuryKeypair.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Verify round status
            const expired = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(expired.status, { expired: {} });
            assert.equal(expired.revealedAnswer, answer);

            // CRITICAL CNTR-10: Verify buyback wallet balance increased by ~47.5% of deposits
            const buybackAfter = await provider.connection.getBalance(
                buybackKeypair.publicKey
            );
            const buybackReceived = buybackAfter - buybackBefore;
            assert.equal(
                buybackReceived,
                buybackExpected,
                "Buyback wallet should receive exactly 47.5% of deposits"
            );

            // Verify treasury received ~5%
            const treasuryAfter = await provider.connection.getBalance(
                treasuryKeypair.publicKey
            );
            assert.equal(
                treasuryAfter - treasuryBefore,
                treasuryExpected,
                "Treasury should receive 5% of deposits"
            );

            // Verify rollover balance (old rollover + 47.5% of deposits as rollover_added)
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            assert.equal(
                gs.rolloverBalance.toNumber(),
                rolloverOutExpected,
                "Rollover should accumulate old rollover + deposit remainder"
            );
        });
    });

    // ---- PDA namespace isolation ----

    it("V2 PDA seeds use v2_ prefix (CNTR-13)", () => {
        // V1 PDAs (different seed prefix)
        const v1Program = anchor.workspace.AlonsBox;
        const [v1GameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("game_state")],
            v1Program.programId
        );
        const [v1VaultPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault")],
            v1Program.programId
        );

        // V2 PDAs (v2_ prefix)
        const [v2GameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_game_state")],
            program.programId
        );
        const [v2VaultPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_vault")],
            program.programId
        );

        // V1 and V2 PDAs must be different addresses
        assert.isFalse(
            v1GameStatePDA.equals(v2GameStatePDA),
            "V1 and V2 game state PDAs should be different"
        );
        assert.isFalse(
            v1VaultPDA.equals(v2VaultPDA),
            "V1 and V2 vault PDAs should be different"
        );

        // Also verify round PDAs differ
        const roundBuf = Buffer.alloc(8);
        roundBuf.writeBigUInt64LE(BigInt(1));
        const [v1RoundPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("round"), roundBuf],
            v1Program.programId
        );
        const [v2RoundPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_round"), roundBuf],
            program.programId
        );
        assert.isFalse(
            v1RoundPDA.equals(v2RoundPDA),
            "V1 and V2 round PDAs should be different"
        );
    });
});
