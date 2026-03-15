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
 * V2 Rollover Accounting Tests
 *
 * Covers: CNTR-08 (rollover accumulation), CNTR-10 (buyback on expire), CNTR-12 (rent-exempt)
 *
 * Tests multi-round rollover accumulation across:
 *   - Settle (50% winner, 5% treasury, 45% rollover)
 *   - Expire (47.5% buyback, 5% treasury, 47.5% rollover from deposits, old rollover preserved)
 *   - Settle-then-expire sequences
 *   - Vault rent-exempt preservation
 *
 * IMPORTANT: All test files share the same on-chain state (same program, same PDAs).
 * This test file reads the current game state at the start and builds relative
 * to the existing rollover balance and round ID.
 */
describe("alons-box-v2 rollover", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
    const authority = (provider.wallet as anchor.Wallet).payer;

    // Read wallets from game state
    let treasuryPk: PublicKey;
    let buybackPk: PublicKey;

    // Players for rollover tests
    const rollPlayer1 = Keypair.generate();
    const rollPlayer2 = Keypair.generate();
    const rollPlayer3 = Keypair.generate();

    // PDAs
    let gameStatePDA: PublicKey;
    let vaultPDA: PublicKey;

    // Constants
    const BASE_FEE = Math.floor(0.05 * LAMPORTS_PER_SOL); // 50_000_000 lamports

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

    async function getNextRoundId(): Promise<number> {
        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        return gs.currentRoundId.toNumber() + 1;
    }

    async function getRolloverBalance(): Promise<number> {
        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        return gs.rolloverBalance.toNumber();
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

        // Airdrop to rollover test players
        for (const kp of [rollPlayer1, rollPlayer2, rollPlayer3]) {
            const sig = await provider.connection.requestAirdrop(
                kp.publicKey,
                10 * LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
        }
    });

    // ---- Test 1: Rollover carries forward on settle (CNTR-08) ----

    it("Rollover carries forward on settle (CNTR-08)", async () => {
        // Read current rollover (R0) -- may be non-zero from prior tests
        const R0 = await getRolloverBalance();

        // Create round N
        const roundId = await getNextRoundId();
        const answer = "roll-settle";
        const salt = "roll-salt-settle-1234567890abcd";
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

        // Verify rollover carried into round
        const round = await program.account.v2Round.fetch(roundPDA);
        assert.equal(
            round.rolloverIn.toNumber(),
            R0,
            "Round should carry forward existing rollover balance"
        );

        // Player enters with base fee
        const [entryPDA] = getV2EntryPDA(roundId, rollPlayer1.publicKey);
        await program.methods
            .enter(new anchor.BN(BASE_FEE))
            .accounts({
                player: rollPlayer1.publicKey,
                round: roundPDA,
                entry: entryPDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([rollPlayer1])
            .rpc();

        // Settle round
        await program.methods
            .settle(answer, salt)
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA,
                vault: vaultPDA,
                winner: rollPlayer1.publicKey,
                treasury: treasuryPk,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        // Read new rollover (R1)
        const R1 = await getRolloverBalance();

        // Calculate expected: pool = deposits + rollover_in = BASE_FEE + R0
        const pool = BASE_FEE + R0;
        const winnerAmount = Math.floor((pool * 5000) / 10000);
        const treasuryAmount = Math.floor((pool * 500) / 10000);
        const expectedRollover = pool - winnerAmount - treasuryAmount;

        // Verify R1 matches expected rollover (direct assignment in settle)
        assert.approximately(
            R1,
            expectedRollover,
            1, // 1 lamport tolerance for rounding
            "Rollover after settle should be ~45% of pool (captures dust)"
        );

        // Verify R1 > 0 (rollover should always be positive after settle)
        assert.isAbove(R1, 0, "Rollover should be positive after settle");
    });

    // ---- Test 2: Rollover accumulates on expire with buyback transfer (CNTR-08, CNTR-10) ----

    it("Rollover accumulates on expire with buyback transfer (CNTR-08, CNTR-10)", async () => {
        // Read current rollover (R1)
        const R1 = await getRolloverBalance();

        // Create round N+1
        const roundId = await getNextRoundId();
        const answer = "roll-expire";
        const salt = "roll-salt-expire-1234567890abcd";
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

        // Player enters
        const [entryPDA] = getV2EntryPDA(roundId, rollPlayer2.publicKey);
        await program.methods
            .enter(new anchor.BN(BASE_FEE))
            .accounts({
                player: rollPlayer2.publicKey,
                round: roundPDA,
                entry: entryPDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([rollPlayer2])
            .rpc();

        // Record buyback wallet balance before expire
        const buybackBefore = await provider.connection.getBalance(buybackPk);

        // Expire round (with buyback_wallet account)
        await program.methods
            .expire(answer, salt)
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA,
                vault: vaultPDA,
                buybackWallet: buybackPk,
                treasury: treasuryPk,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        // Read new rollover (R2)
        const R2 = await getRolloverBalance();

        // Expected: expire payouts from deposits only, old rollover preserved
        // buyback = 47.5% of BASE_FEE
        // treasury = 5% of BASE_FEE
        // rollover_added = BASE_FEE - buyback - treasury
        // R2 = R1 + rollover_added
        const buybackExpected = Math.floor((BASE_FEE * 4750) / 10000);
        const treasuryExpected = Math.floor((BASE_FEE * 500) / 10000);
        const rolloverAdded = BASE_FEE - buybackExpected - treasuryExpected;
        const expectedR2 = R1 + rolloverAdded;

        assert.approximately(
            R2,
            expectedR2,
            1,
            "Rollover should accumulate: old rollover + deposit remainder"
        );
        assert.isAbove(R2, R1, "Rollover must increase after expire");

        // Verify buyback wallet received ~47.5% of deposits
        const buybackAfter = await provider.connection.getBalance(buybackPk);
        assert.equal(
            buybackAfter - buybackBefore,
            buybackExpected,
            "Buyback wallet should receive 47.5% of deposits on expire"
        );
    });

    // ---- Test 3: Rollover persists across settle-then-expire sequence (CNTR-08) ----

    it("Rollover persists across settle then expire sequence (CNTR-08)", async () => {
        // --- Sub-round A: settle with multiple players ---
        const R2 = await getRolloverBalance();
        const roundIdA = await getNextRoundId();
        const answerA = "roll-seq-settle";
        const saltA = "roll-salt-seq-settle-abcdef1234";
        const [roundPDA_A] = getV2RoundPDA(roundIdA);

        await program.methods
            .createRound(
                new anchor.BN(roundIdA),
                computeCommitHash(answerA, saltA)
            )
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA_A,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        // Two players enter
        const [entry1PDA] = getV2EntryPDA(roundIdA, rollPlayer1.publicKey);
        await program.methods
            .enter(new anchor.BN(BASE_FEE))
            .accounts({
                player: rollPlayer1.publicKey,
                round: roundPDA_A,
                entry: entry1PDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([rollPlayer1])
            .rpc();

        const [entry2PDA] = getV2EntryPDA(roundIdA, rollPlayer3.publicKey);
        await program.methods
            .enter(new anchor.BN(BASE_FEE))
            .accounts({
                player: rollPlayer3.publicKey,
                round: roundPDA_A,
                entry: entry2PDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([rollPlayer3])
            .rpc();

        // Settle round A
        await program.methods
            .settle(answerA, saltA)
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA_A,
                vault: vaultPDA,
                winner: rollPlayer1.publicKey,
                treasury: treasuryPk,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const R3 = await getRolloverBalance();

        // Verify: pool = 2 * BASE_FEE + R2, rollover = pool - winner - treasury
        const poolA = 2 * BASE_FEE + R2;
        const winnerA = Math.floor((poolA * 5000) / 10000);
        const treasuryA = Math.floor((poolA * 500) / 10000);
        const expectedR3 = poolA - winnerA - treasuryA;

        assert.approximately(
            R3,
            expectedR3,
            1,
            "Rollover after settle should be pool residual"
        );

        // --- Sub-round B: expire ---
        const roundIdB = await getNextRoundId();
        const answerB = "roll-seq-expire";
        const saltB = "roll-salt-seq-expire-abcdef1234";
        const [roundPDA_B] = getV2RoundPDA(roundIdB);

        await program.methods
            .createRound(
                new anchor.BN(roundIdB),
                computeCommitHash(answerB, saltB)
            )
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA_B,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        // Player enters
        const [entry3PDA] = getV2EntryPDA(roundIdB, rollPlayer2.publicKey);
        await program.methods
            .enter(new anchor.BN(BASE_FEE))
            .accounts({
                player: rollPlayer2.publicKey,
                round: roundPDA_B,
                entry: entry3PDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([rollPlayer2])
            .rpc();

        // Record buyback balance for verification
        const buybackBefore = await provider.connection.getBalance(buybackPk);

        // Expire round B (with buyback_wallet account)
        await program.methods
            .expire(answerB, saltB)
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA_B,
                vault: vaultPDA,
                buybackWallet: buybackPk,
                treasury: treasuryPk,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const R4 = await getRolloverBalance();

        // Verify R4 > R3 (accumulation continues)
        assert.isAbove(
            R4,
            R3,
            "Rollover must continue accumulating across settle->expire sequence"
        );

        // Verify buyback wallet received its share
        const buybackAfter = await provider.connection.getBalance(buybackPk);
        const buybackExpected = Math.floor((BASE_FEE * 4750) / 10000);
        assert.equal(
            buybackAfter - buybackBefore,
            buybackExpected,
            "Buyback wallet should receive 47.5% of deposits in expire"
        );
    });

    // ---- Test 4: Rollover never drops vault below rent-exempt (CNTR-12) ----

    it("Rollover never drops vault below rent-exempt (CNTR-12)", async () => {
        // After all the above rounds, verify vault account still exists
        // and has lamports >= minimum_balance for V2Vault data size
        const vaultBalance = await provider.connection.getBalance(vaultPDA);

        // V2Vault data is 1 byte (bump only). Minimum balance for rent-exemption
        // of 1 byte of data: use getMinimumBalanceForRentExemption
        const rentExemptMin =
            await provider.connection.getMinimumBalanceForRentExemption(1);

        assert.isAtLeast(
            vaultBalance,
            rentExemptMin,
            "Vault must remain rent-exempt after all operations"
        );

        // Also verify the vault account exists (not garbage-collected)
        const vaultInfo = await provider.connection.getAccountInfo(vaultPDA);
        assert.isNotNull(
            vaultInfo,
            "Vault account must still exist after all rounds"
        );

        // Verify vault balance >= rollover_balance + rent_exempt
        // This ensures the vault actually holds enough to cover stored rollover
        const rollover = await getRolloverBalance();
        assert.isAtLeast(
            vaultBalance,
            rollover + rentExemptMin,
            "Vault balance should cover rollover balance plus rent exemption"
        );
    });
});
