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
 * V2 Donate Tests
 *
 * Tests the donate instruction that adds SOL directly to rollover.
 */
describe("alons-box-v2 donate", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
    const authority = (provider.wallet as anchor.Wallet).payer;

    // Wallets (may be overwritten if game state already exists)
    let treasuryKeypair = Keypair.generate();
    let buybackKeypair = Keypair.generate();
    let treasuryPubkey: PublicKey;
    let buybackPubkey: PublicKey;

    // Donors / Players
    const donor1 = Keypair.generate();
    const donor2 = Keypair.generate();
    const player1 = Keypair.generate();

    // PDAs
    let gameStatePDA: PublicKey;
    let vaultPDA: PublicKey;

    // Dynamic round tracking
    let nextRoundId: number;

    // Constants
    const ROUND_DURATION = 1200;
    const ENTRY_CUTOFF = 180;
    const BASE_FEE = Math.floor(0.05 * LAMPORTS_PER_SOL);
    const DONATE_AMOUNT = Math.floor(0.1 * LAMPORTS_PER_SOL);

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
        [gameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_game_state")],
            program.programId
        );
        [vaultPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_vault")],
            program.programId
        );

        // Airdrop donors and players
        for (const kp of [donor1, donor2, player1]) {
            const sig = await provider.connection.requestAirdrop(
                kp.publicKey,
                10 * LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
        }

        // Check if game state already exists (other test files may have initialized it)
        const gsAccount = await provider.connection.getAccountInfo(gameStatePDA);
        if (gsAccount) {
            // Read existing state — use its treasury/buyback
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            treasuryPubkey = gs.treasury;
            buybackPubkey = gs.buybackWallet;
            nextRoundId = gs.currentRoundId.toNumber() + 1;
        } else {
            // First test file to run — initialize
            for (const kp of [treasuryKeypair, buybackKeypair]) {
                const sig = await provider.connection.requestAirdrop(
                    kp.publicKey,
                    10 * LAMPORTS_PER_SOL
                );
                await provider.connection.confirmTransaction(sig);
            }
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
            treasuryPubkey = treasuryKeypair.publicKey;
            buybackPubkey = buybackKeypair.publicKey;
            nextRoundId = 1;
        }

        // Ensure treasury/buyback have SOL for receiving transfers
        for (const pk of [treasuryPubkey, buybackPubkey]) {
            const bal = await provider.connection.getBalance(pk);
            if (bal < LAMPORTS_PER_SOL) {
                const sig = await provider.connection.requestAirdrop(
                    pk,
                    5 * LAMPORTS_PER_SOL
                );
                await provider.connection.confirmTransaction(sig);
            }
        }
    });

    // ---- Tests ----

    it("Donates SOL and increases rollover balance", async () => {
        const gsBefore = await program.account.v2GameState.fetch(gameStatePDA);
        const vaultBefore = await provider.connection.getBalance(vaultPDA);
        const rolloverBefore = gsBefore.rolloverBalance.toNumber();

        await program.methods
            .donate(new anchor.BN(DONATE_AMOUNT))
            .accounts({
                donor: donor1.publicKey,
                gameState: gameStatePDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([donor1])
            .rpc();

        const gsAfter = await program.account.v2GameState.fetch(gameStatePDA);
        const vaultAfter = await provider.connection.getBalance(vaultPDA);

        assert.equal(
            gsAfter.rolloverBalance.toNumber(),
            rolloverBefore + DONATE_AMOUNT,
            "Rollover balance should increase by donation amount"
        );
        assert.equal(
            vaultAfter - vaultBefore,
            DONATE_AMOUNT,
            "Vault balance should increase by donation amount"
        );
    });

    it("Multiple donations accumulate", async () => {
        const gsBefore = await program.account.v2GameState.fetch(gameStatePDA);
        const rolloverBefore = gsBefore.rolloverBalance.toNumber();
        const secondAmount = Math.floor(0.2 * LAMPORTS_PER_SOL);

        await program.methods
            .donate(new anchor.BN(secondAmount))
            .accounts({
                donor: donor2.publicKey,
                gameState: gameStatePDA,
                vault: vaultPDA,
                systemProgram: SystemProgram.programId,
            })
            .signers([donor2])
            .rpc();

        const gsAfter = await program.account.v2GameState.fetch(gameStatePDA);
        assert.equal(
            gsAfter.rolloverBalance.toNumber(),
            rolloverBefore + secondAmount,
            "Rollover should accumulate across donations"
        );
    });

    it("Rejects zero donation amount", async () => {
        try {
            await program.methods
                .donate(new anchor.BN(0))
                .accounts({
                    donor: donor1.publicKey,
                    gameState: gameStatePDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([donor1])
                .rpc();
            assert.fail("Should have thrown InvalidDonation");
        } catch (err: any) {
            assert.include(
                err.toString(),
                "InvalidDonation",
                "Should reject zero donation"
            );
        }
    });

    describe("Donate during active round -- settle preserves donations", () => {
        const answer = "red apple";
        const salt = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
        const commitHash = computeCommitHash(answer, salt);
        let roundPDA: PublicKey;
        let donationDuringRound: number;

        it("Creates round (picks up prior donations as rollover_in)", async () => {
            [roundPDA] = getV2RoundPDA(nextRoundId);

            await program.methods
                .createRound(new anchor.BN(nextRoundId), commitHash)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.isAbove(
                round.rolloverIn.toNumber(),
                0,
                "Round should carry donations as rollover_in"
            );
        });

        it("Donates during active round", async () => {
            donationDuringRound = Math.floor(0.5 * LAMPORTS_PER_SOL);

            await program.methods
                .donate(new anchor.BN(donationDuringRound))
                .accounts({
                    donor: donor1.publicKey,
                    gameState: gameStatePDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([donor1])
                .rpc();
        });

        it("Player enters", async () => {
            const [entryPDA] = getV2EntryPDA(nextRoundId, player1.publicKey);

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
        });

        it("Settle preserves mid-round donation in rollover", async () => {
            const round = await program.account.v2Round.fetch(roundPDA);
            const totalDeposits = round.totalDeposits.toNumber();
            const rolloverIn = round.rolloverIn.toNumber();
            const pool = totalDeposits + rolloverIn;

            // Expected splits
            const winnerExpected = Math.floor((pool * 5000) / 10000);
            const yesPoolExpected = Math.floor((pool * 1500) / 10000);
            const treasuryExpected = Math.floor((pool * 500) / 10000);
            // No evidence, so yes_pool goes to rollover
            const rolloverFromPool = pool - winnerExpected - yesPoolExpected - treasuryExpected + yesPoolExpected;

            await program.methods
                .settle(answer, salt)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    vault: vaultPDA,
                    winner: player1.publicKey,
                    treasury: treasuryPubkey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            // Rollover should include: computed rollover from pool + donation during round
            assert.equal(
                gs.rolloverBalance.toNumber(),
                rolloverFromPool + donationDuringRound,
                "Rollover should include mid-round donation"
            );
        });
    });

    describe("Donate during active round -- expire preserves donations", () => {
        const answer = "blue chair";
        const salt = "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6";
        const commitHash = computeCommitHash(answer, salt);
        let roundPDA: PublicKey;
        let donationDuringRound: number;

        it("Creates round 2", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const round2Id = gs.currentRoundId.toNumber() + 1;
            [roundPDA] = getV2RoundPDA(round2Id);

            await program.methods
                .createRound(new anchor.BN(round2Id), commitHash)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        });

        it("Player enters round 2", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const currentId = gs.currentRoundId.toNumber();
            const [entryPDA] = getV2EntryPDA(currentId, player1.publicKey);

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
        });

        it("Donates during active round 2", async () => {
            donationDuringRound = Math.floor(0.3 * LAMPORTS_PER_SOL);

            await program.methods
                .donate(new anchor.BN(donationDuringRound))
                .accounts({
                    donor: donor1.publicKey,
                    gameState: gameStatePDA,
                    vault: vaultPDA,
                    systemProgram: SystemProgram.programId,
                })
                .signers([donor1])
                .rpc();
        });

        it("Expire preserves mid-round donation in rollover", async () => {
            const round = await program.account.v2Round.fetch(roundPDA);
            const totalDeposits = round.totalDeposits.toNumber();
            const rolloverIn = round.rolloverIn.toNumber();

            // Expire splits from deposits only
            const buybackExpected = Math.floor((totalDeposits * 4750) / 10000);
            const treasuryExpected = Math.floor((totalDeposits * 500) / 10000);
            const rolloverAdded = totalDeposits - buybackExpected - treasuryExpected;
            const rolloverOut = rolloverIn + rolloverAdded;

            await program.methods
                .expire(answer, salt)
                .accounts({
                    authority: authority.publicKey,
                    gameState: gameStatePDA,
                    round: roundPDA,
                    vault: vaultPDA,
                    buybackWallet: buybackPubkey,
                    treasury: treasuryPubkey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            assert.equal(
                gs.rolloverBalance.toNumber(),
                rolloverOut + donationDuringRound,
                "Rollover should include mid-round donation after expire"
            );
        });
    });
});
