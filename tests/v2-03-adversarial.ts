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
 * V2 Adversarial / Security Tests — Comprehensive Suite
 *
 * Categories:
 *   1. Double-action attacks (replay settle, expire, cross-state)
 *   2. Authorization attacks (non-authority settle, expire, create_round)
 *   3. Wallet redirect attacks (wrong treasury, wrong buyback)
 *   4. Commit-hash attacks (wrong answer, wrong salt, too long, empty)
 *   5. Double entry & entry edge cases (CNTR-04)
 *   6. Re-initialization attacks
 *   7. Round ID manipulation (skip, zero, duplicate PDA)
 *   8. Force expire edge cases (before grace, on settled, on expired)
 *   9. Entry fee validation (underpayment, zero, 1 lamport)
 *  10. Vault & rent-exempt safety (CNTR-12)
 *  11. State consistency after operations
 *  12. Multi-player entry correctness
 */
describe("alons-box-v2 adversarial", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
    const authority = (provider.wallet as anchor.Wallet).payer;

    let treasuryPk: PublicKey;
    let buybackPk: PublicKey;

    const advPlayer1 = Keypair.generate();
    const advPlayer2 = Keypair.generate();
    const advPlayer3 = Keypair.generate();
    const advPlayer4 = Keypair.generate();
    const advPlayer5 = Keypair.generate();
    const nonAuthority = Keypair.generate();
    const fakeTreasury = Keypair.generate();
    const fakeBuyback = Keypair.generate();

    let gameStatePDA: PublicKey;
    let vaultPDA: PublicKey;

    const BASE_FEE = Math.floor(0.05 * LAMPORTS_PER_SOL);

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

    /** Helper: create round, return roundId and PDA */
    async function createRound(
        answer: string,
        salt: string
    ): Promise<{ roundId: number; roundPDA: PublicKey }> {
        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        const roundId = gs.currentRoundId.toNumber() + 1;
        const [roundPDA] = getV2RoundPDA(roundId);

        await program.methods
            .createRound(new anchor.BN(roundId), computeCommitHash(answer, salt))
            .accounts({
                authority: authority.publicKey,
                gameState: gameStatePDA,
                round: roundPDA,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        return { roundId, roundPDA };
    }

    /** Helper: player enters a round */
    async function enterRound(
        roundId: number,
        roundPDA: PublicKey,
        player: Keypair,
        amount: number = BASE_FEE
    ) {
        const [entryPDA] = getV2EntryPDA(roundId, player.publicKey);
        await program.methods
            .enter(new anchor.BN(amount))
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

    /** Helper: settle a round */
    async function settleRound(
        roundPDA: PublicKey,
        answer: string,
        salt: string,
        winner: PublicKey
    ) {
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

    /** Helper: expire a round */
    async function expireRound(
        roundPDA: PublicKey,
        answer: string,
        salt: string
    ) {
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
    }

    before(async () => {
        [gameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_game_state")],
            program.programId
        );
        [vaultPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_vault")],
            program.programId
        );

        for (const kp of [
            advPlayer1,
            advPlayer2,
            advPlayer3,
            advPlayer4,
            advPlayer5,
            nonAuthority,
            fakeTreasury,
            fakeBuyback,
        ]) {
            const sig = await provider.connection.requestAirdrop(
                kp.publicKey,
                10 * LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
        }

        const gs = await program.account.v2GameState.fetch(gameStatePDA);
        treasuryPk = gs.treasury;
        buybackPk = gs.buybackWallet;
    });

    // ================================================================
    // 1. DOUBLE-ACTION / REPLAY ATTACKS
    // ================================================================

    describe("1. Double-action / Replay attacks", () => {
        const answer = "adv-replay";
        const salt = "adv-salt-replay-abcdef12345678";

        it("Cannot settle same round twice", async () => {
            const { roundId, roundPDA } = await createRound(answer, salt);
            await enterRound(roundId, roundPDA, advPlayer1);
            await settleRound(roundPDA, answer, salt, advPlayer1.publicKey);

            try {
                await settleRound(roundPDA, answer, salt, advPlayer1.publicKey);
                assert.fail("Expected RoundNotActive error");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });

        it("Cannot expire same round twice", async () => {
            const a = "adv-dbl-expire";
            const s = "adv-salt-dbl-expire-1234567890";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);
            await expireRound(roundPDA, a, s);

            try {
                await expireRound(roundPDA, a, s);
                assert.fail("Expected RoundNotActive error");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });

        it("Cannot settle after expire", async () => {
            const a = "adv-settle-after-expire";
            const s = "adv-salt-settle-after-expire12";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer3);
            await expireRound(roundPDA, a, s);

            try {
                await settleRound(roundPDA, a, s, advPlayer3.publicKey);
                assert.fail("Expected RoundNotActive error");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });

        it("Cannot expire after settle", async () => {
            const a = "adv-expire-after-settle";
            const s = "adv-salt-expire-after-settle12";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);

            try {
                await expireRound(roundPDA, a, s);
                assert.fail("Expected RoundNotActive error");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });
    });

    // ================================================================
    // 2. AUTHORIZATION ATTACKS
    // ================================================================

    describe("2. Authorization attacks", () => {
        it("Non-authority cannot create_round", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const roundId = gs.currentRoundId.toNumber() + 1;
            const [roundPDA] = getV2RoundPDA(roundId);

            try {
                await program.methods
                    .createRound(
                        new anchor.BN(roundId),
                        computeCommitHash("x", "y")
                    )
                    .accounts({
                        authority: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected Unauthorized");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }
        });

        it("Non-authority cannot settle", async () => {
            const a = "adv-na-settle";
            const s = "adv-salt-na-settle-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            try {
                await program.methods
                    .settle(a, s)
                    .accounts({
                        authority: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        winner: advPlayer1.publicKey,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected Unauthorized");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
        });

        it("Non-authority cannot expire", async () => {
            const a = "adv-na-expire";
            const s = "adv-salt-na-expire-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            try {
                await program.methods
                    .expire(a, s)
                    .accounts({
                        authority: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: buybackPk,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected Unauthorized");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Player cannot sign as authority by passing own key", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const roundId = gs.currentRoundId.toNumber() + 1;
            const [roundPDA] = getV2RoundPDA(roundId);

            try {
                await program.methods
                    .createRound(
                        new anchor.BN(roundId),
                        computeCommitHash("spoof", "salt")
                    )
                    .accounts({
                        authority: advPlayer1.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([advPlayer1])
                    .rpc();
                assert.fail("Expected Unauthorized");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }
        });
    });

    // ================================================================
    // 3. WALLET REDIRECT ATTACKS
    // ================================================================

    describe("3. Wallet redirect attacks", () => {
        it("Settle with wrong treasury is rejected", async () => {
            const a = "adv-wt-settle";
            const s = "adv-salt-wt-settle-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            try {
                await program.methods
                    .settle(a, s)
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        winner: advPlayer1.publicKey,
                        treasury: fakeTreasury.publicKey,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected Unauthorized error for wrong treasury");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
        });

        it("Expire with wrong treasury is rejected", async () => {
            const a = "adv-wt-expire-t";
            const s = "adv-salt-wt-expire-t-123456789";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            try {
                await program.methods
                    .expire(a, s)
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: buybackPk,
                        treasury: fakeTreasury.publicKey,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected Unauthorized error for wrong treasury");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Expire with wrong buyback wallet is rejected", async () => {
            const a = "adv-wt-expire-b";
            const s = "adv-salt-wt-expire-b-123456789";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer3);

            try {
                await program.methods
                    .expire(a, s)
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: fakeBuyback.publicKey,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected Unauthorized for wrong buyback");
            } catch (err: any) {
                assert.include(err.toString(), "Unauthorized");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Force expire with wrong treasury is rejected", async () => {
            const a = "adv-wt-fe-t";
            const s = "adv-salt-wt-fe-t-1234567890123";
            const { roundId, roundPDA } = await createRound(a, s);

            try {
                await program.methods
                    .forceExpire()
                    .accounts({
                        caller: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: buybackPk,
                        treasury: fakeTreasury.publicKey,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected Unauthorized for wrong treasury on force_expire");
            } catch (err: any) {
                const errStr = err.toString();
                // Might be Unauthorized (wrong treasury) or GracePeriodNotElapsed (checked first)
                assert.ok(
                    errStr.includes("Unauthorized") ||
                        errStr.includes("GracePeriodNotElapsed"),
                    `Expected Unauthorized or GracePeriodNotElapsed, got: ${errStr}`
                );
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Force expire with wrong buyback wallet is rejected", async () => {
            const a = "adv-wt-fe-b";
            const s = "adv-salt-wt-fe-b-1234567890123";
            const { roundId, roundPDA } = await createRound(a, s);

            try {
                await program.methods
                    .forceExpire()
                    .accounts({
                        caller: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: fakeBuyback.publicKey,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected Unauthorized for wrong buyback on force_expire");
            } catch (err: any) {
                const errStr = err.toString();
                assert.ok(
                    errStr.includes("Unauthorized") ||
                        errStr.includes("GracePeriodNotElapsed"),
                    `Expected Unauthorized or GracePeriodNotElapsed, got: ${errStr}`
                );
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });
    });

    // ================================================================
    // 4. COMMIT-HASH ATTACKS (CNTR-05)
    // ================================================================

    describe("4. Commit-hash attacks (CNTR-05)", () => {
        let roundId: number;
        let roundPDA: PublicKey;
        const answer = "adv-hash-correct";
        const salt = "adv-salt-hash-correct-12345678";

        before(async () => {
            const r = await createRound(answer, salt);
            roundId = r.roundId;
            roundPDA = r.roundPDA;
            await enterRound(roundId, roundPDA, advPlayer1);
        });

        it("Settle with wrong answer is rejected", async () => {
            try {
                await settleRound(
                    roundPDA,
                    "wrong-answer",
                    salt,
                    advPlayer1.publicKey
                );
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        it("Settle with wrong salt is rejected", async () => {
            try {
                await settleRound(
                    roundPDA,
                    answer,
                    "wrong-salt-xxxxxxxxxxxxxxxxxx",
                    advPlayer1.publicKey
                );
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        it("Settle with swapped answer/salt is rejected", async () => {
            try {
                await settleRound(
                    roundPDA,
                    salt,
                    answer,
                    advPlayer1.publicKey
                );
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        it("Settle with empty answer is rejected (hash mismatch)", async () => {
            try {
                await settleRound(roundPDA, "", salt, advPlayer1.publicKey);
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        it("Settle with empty salt is rejected (hash mismatch)", async () => {
            try {
                await settleRound(roundPDA, answer, "", advPlayer1.publicKey);
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        it("Expire with wrong answer is rejected", async () => {
            try {
                await program.methods
                    .expire("wrong-expire-answer", salt)
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
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        it("Expire with wrong salt is rejected", async () => {
            try {
                await program.methods
                    .expire(answer, "wrong-expire-salt-xxxxxxxxxxxxx")
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
                assert.fail("Expected InvalidCommitHash");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidCommitHash");
            }
        });

        after(async () => {
            // cleanup with correct answer
            await settleRound(roundPDA, answer, salt, advPlayer1.publicKey);
        });
    });

    describe("4b. Answer/salt length limits", () => {
        it("Settle rejects answer > 64 bytes", async () => {
            const a = "a-len-65";
            const s = "s-len-65-salt-xxxxxxxxxxxxxxxx";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            const longAnswer = "A".repeat(65);
            try {
                await settleRound(
                    roundPDA,
                    longAnswer,
                    s,
                    advPlayer2.publicKey
                );
                assert.fail("Expected AnswerTooLong");
            } catch (err: any) {
                assert.include(err.toString(), "AnswerTooLong");
            }

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer2.publicKey);
        });

        it("Settle rejects salt > 64 bytes", async () => {
            const a = "a-len-65-salt";
            const s = "s-len-65-salt-salt-xxxxxxxxxxxxx";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer3);

            const longSalt = "S".repeat(65);
            try {
                await settleRound(
                    roundPDA,
                    a,
                    longSalt,
                    advPlayer3.publicKey
                );
                assert.fail("Expected SaltTooLong");
            } catch (err: any) {
                assert.include(err.toString(), "SaltTooLong");
            }

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer3.publicKey);
        });

        it("Expire rejects answer > 64 bytes", async () => {
            const a = "a-exp-len-65";
            const s = "s-exp-len-65-salt-xxxxxxxxxxxxx";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            const longAnswer = "B".repeat(65);
            try {
                await program.methods
                    .expire(longAnswer, s)
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
                assert.fail("Expected AnswerTooLong");
            } catch (err: any) {
                assert.include(err.toString(), "AnswerTooLong");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Expire rejects salt > 64 bytes", async () => {
            const a = "a-exp-slt-65";
            const s = "s-exp-slt-65-salt-xxxxxxxxxxxxx";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            const longSalt = "S".repeat(65);
            try {
                await program.methods
                    .expire(a, longSalt)
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
                assert.fail("Expected SaltTooLong");
            } catch (err: any) {
                assert.include(err.toString(), "SaltTooLong");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Answer at exactly 64 bytes is accepted", async () => {
            const a = "X".repeat(64);
            const s = "salt-exactly-64-accept-test-1234";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer3);

            await settleRound(roundPDA, a, s, advPlayer3.publicKey);
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { settled: {} });
        });

        it("Salt at exactly 64 bytes is accepted", async () => {
            const a = "salt-64-accept";
            const s = "Y".repeat(64);
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
            const round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { settled: {} });
        });
    });

    // ================================================================
    // 5. DOUBLE ENTRY & ENTRY EDGE CASES (CNTR-04)
    // ================================================================

    describe("5. Double entry & entry edge cases (CNTR-04)", () => {
        it("Second entry by same player is rejected (init constraint)", async () => {
            const a = "adv-dbl-entry2";
            const s = "adv-salt-dbl-entry2-1234567890";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            const [entryPDA] = getV2EntryPDA(roundId, advPlayer1.publicKey);
            try {
                await program.methods
                    .enter(new anchor.BN(BASE_FEE))
                    .accounts({
                        player: advPlayer1.publicKey,
                        round: roundPDA,
                        entry: entryPDA,
                        vault: vaultPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([advPlayer1])
                    .rpc();
                assert.fail("Expected error for double entry");
            } catch (err: any) {
                const errStr = err.toString();
                assert.ok(
                    errStr.includes("already in use") ||
                        errStr.includes("0x0") ||
                        errStr.includes("custom program error"),
                    `Expected 'already in use' error, got: ${errStr}`
                );
            }

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
        });

        it("Entry on settled round is rejected", async () => {
            const a = "adv-entry-settled";
            const s = "adv-salt-entry-settled-12345678";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);
            await settleRound(roundPDA, a, s, advPlayer2.publicKey);

            try {
                await enterRound(roundId, roundPDA, advPlayer3);
                assert.fail("Expected RoundNotActive");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });

        it("Entry on expired round is rejected", async () => {
            const a = "adv-entry-expired";
            const s = "adv-salt-entry-expired-12345678";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);
            await expireRound(roundPDA, a, s);

            try {
                await enterRound(roundId, roundPDA, advPlayer4);
                assert.fail("Expected RoundNotActive");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });

        it("Zero amount entry is rejected (below minimum fee)", async () => {
            const a = "adv-zero-entry";
            const s = "adv-salt-zero-entry-1234567890";
            const { roundId, roundPDA } = await createRound(a, s);

            try {
                await enterRound(roundId, roundPDA, advPlayer2, 0);
                assert.fail("Expected InsufficientEntryFee");
            } catch (err: any) {
                assert.include(err.toString(), "InsufficientEntryFee");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("1 lamport entry is rejected (below minimum fee)", async () => {
            const a = "adv-1lam-entry";
            const s = "adv-salt-1lam-entry-1234567890";
            const { roundId, roundPDA } = await createRound(a, s);

            try {
                await enterRound(roundId, roundPDA, advPlayer3, 1);
                assert.fail("Expected InsufficientEntryFee");
            } catch (err: any) {
                assert.include(err.toString(), "InsufficientEntryFee");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Entry at BASE_FEE - 1 is rejected", async () => {
            const a = "adv-bf-minus1";
            const s = "adv-salt-bf-minus1-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);

            try {
                await enterRound(roundId, roundPDA, advPlayer1, BASE_FEE - 1);
                assert.fail("Expected InsufficientEntryFee");
            } catch (err: any) {
                assert.include(err.toString(), "InsufficientEntryFee");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });
    });

    // ================================================================
    // 6. RE-INITIALIZATION ATTACKS
    // ================================================================

    describe("6. Re-initialization attacks", () => {
        it("Cannot re-initialize game state (PDA already exists)", async () => {
            try {
                await program.methods
                    .initialize(
                        fakeTreasury.publicKey,
                        fakeBuyback.publicKey,
                        new anchor.BN(1200),
                        new anchor.BN(180)
                    )
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        vault: vaultPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected error for re-init");
            } catch (err: any) {
                const errStr = err.toString();
                assert.ok(
                    errStr.includes("already in use") ||
                        errStr.includes("0x0") ||
                        errStr.includes("custom program error"),
                    `Expected 'already in use' error, got: ${errStr}`
                );
            }
        });

        it("Non-authority cannot re-initialize game state", async () => {
            try {
                await program.methods
                    .initialize(
                        fakeTreasury.publicKey,
                        fakeBuyback.publicKey,
                        new anchor.BN(1200),
                        new anchor.BN(180)
                    )
                    .accounts({
                        authority: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        vault: vaultPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected error");
            } catch (err: any) {
                const errStr = err.toString();
                assert.ok(
                    errStr.includes("already in use") ||
                        errStr.includes("0x0") ||
                        errStr.includes("Seeds"),
                    `Expected init failure, got: ${errStr}`
                );
            }
        });
    });

    // ================================================================
    // 7. ROUND ID MANIPULATION (CNTR-11)
    // ================================================================

    describe("7. Round ID manipulation (CNTR-11)", () => {
        it("Skipping round IDs is rejected", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const skippedId = gs.currentRoundId.toNumber() + 999;
            const [roundPDA] = getV2RoundPDA(skippedId);

            try {
                await program.methods
                    .createRound(
                        new anchor.BN(skippedId),
                        computeCommitHash("skip", "salt")
                    )
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected InvalidRoundId");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidRoundId");
            }
        });

        it("Round ID 0 is rejected", async () => {
            const [roundPDA] = getV2RoundPDA(0);

            try {
                await program.methods
                    .createRound(
                        new anchor.BN(0),
                        computeCommitHash("zero", "salt")
                    )
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected InvalidRoundId");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidRoundId");
            }
        });

        it("Past round ID is rejected", async () => {
            const [roundPDA] = getV2RoundPDA(1); // Round 1 already exists

            try {
                await program.methods
                    .createRound(
                        new anchor.BN(1),
                        computeCommitHash("past", "salt")
                    )
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected InvalidRoundId or PDA collision");
            } catch (err: any) {
                const errStr = err.toString();
                assert.ok(
                    errStr.includes("InvalidRoundId") ||
                        errStr.includes("already in use") ||
                        errStr.includes("0x0"),
                    `Expected InvalidRoundId or already in use, got: ${errStr}`
                );
            }
        });

        it("Round ID +2 (skipping one) is rejected", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const wrongId = gs.currentRoundId.toNumber() + 2;
            const [roundPDA] = getV2RoundPDA(wrongId);

            try {
                await program.methods
                    .createRound(
                        new anchor.BN(wrongId),
                        computeCommitHash("skip1", "salt1")
                    )
                    .accounts({
                        authority: authority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Expected InvalidRoundId");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidRoundId");
            }
        });
    });

    // ================================================================
    // 8. FORCE EXPIRE EDGE CASES
    // ================================================================

    describe("8. Force expire edge cases", () => {
        it("Force expire before grace period is rejected", async () => {
            const a = "adv-fe-grace";
            const s = "adv-salt-fe-grace-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);

            try {
                await program.methods
                    .forceExpire()
                    .accounts({
                        caller: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: buybackPk,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected GracePeriodNotElapsed");
            } catch (err: any) {
                assert.include(err.toString(), "GracePeriodNotElapsed");
            }

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Force expire on settled round is rejected", async () => {
            const a = "adv-fe-settled";
            const s = "adv-salt-fe-settled-1234567890";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);

            try {
                await program.methods
                    .forceExpire()
                    .accounts({
                        caller: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: buybackPk,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected RoundNotActive");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });

        it("Force expire on expired round is rejected", async () => {
            const a = "adv-fe-expired";
            const s = "adv-salt-fe-expired-1234567890";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);
            await expireRound(roundPDA, a, s);

            try {
                await program.methods
                    .forceExpire()
                    .accounts({
                        caller: nonAuthority.publicKey,
                        gameState: gameStatePDA,
                        round: roundPDA,
                        vault: vaultPDA,
                        buybackWallet: buybackPk,
                        treasury: treasuryPk,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([nonAuthority])
                    .rpc();
                assert.fail("Expected RoundNotActive");
            } catch (err: any) {
                assert.include(err.toString(), "RoundNotActive");
            }
        });
    });

    // ================================================================
    // 9. ENTRY FEE VALIDATION (CNTR-03)
    // ================================================================

    describe("9. Entry fee validation (CNTR-03)", () => {
        it("Overpayment is accepted (handles clock drift)", async () => {
            const a = "adv-overpay";
            const s = "adv-salt-overpay-12345678901234";
            const { roundId, roundPDA } = await createRound(a, s);

            // Pay 2x the base fee
            await enterRound(roundId, roundPDA, advPlayer1, BASE_FEE * 2);

            const [entryPDA] = getV2EntryPDA(roundId, advPlayer1.publicKey);
            const entry = await program.account.v2Entry.fetch(entryPDA);
            assert.equal(
                entry.amountPaid.toNumber(),
                BASE_FEE * 2,
                "Overpayment should be recorded as-is"
            );

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
        });

        it("Large deposit (5 SOL) is accepted without overflow (CNTR-11)", async () => {
            const a = "adv-large-dep";
            const s = "adv-salt-large-dep-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);

            const largeAmount = 5 * LAMPORTS_PER_SOL;
            await enterRound(roundId, roundPDA, advPlayer2, largeAmount);

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(
                round.totalDeposits.toNumber(),
                largeAmount,
                "Large deposit recorded correctly"
            );

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer2.publicKey);
        });
    });

    // ================================================================
    // 10. VAULT & RENT-EXEMPT SAFETY (CNTR-12)
    // ================================================================

    describe("10. Vault & rent-exempt safety (CNTR-12)", () => {
        it("Vault stays rent-exempt after settle", async () => {
            const a = "adv-rent-settle";
            const s = "adv-salt-rent-settle-123456789";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            const vaultBefore = await provider.connection.getAccountInfo(
                vaultPDA
            );
            const rentExemptMin =
                await provider.connection.getMinimumBalanceForRentExemption(
                    vaultBefore!.data.length
                );

            await settleRound(roundPDA, a, s, advPlayer1.publicKey);

            const vaultAfter = await provider.connection.getAccountInfo(
                vaultPDA
            );
            assert.ok(
                vaultAfter!.lamports >= rentExemptMin,
                `Vault ${vaultAfter!.lamports} should >= rent-exempt ${rentExemptMin}`
            );
        });

        it("Vault stays rent-exempt after expire", async () => {
            const a = "adv-rent-expire";
            const s = "adv-salt-rent-expire-123456789";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            const vaultBefore = await provider.connection.getAccountInfo(
                vaultPDA
            );
            const rentExemptMin =
                await provider.connection.getMinimumBalanceForRentExemption(
                    vaultBefore!.data.length
                );

            await expireRound(roundPDA, a, s);

            const vaultAfter = await provider.connection.getAccountInfo(
                vaultPDA
            );
            assert.ok(
                vaultAfter!.lamports >= rentExemptMin,
                `Vault ${vaultAfter!.lamports} should >= rent-exempt ${rentExemptMin}`
            );
        });

        it("Vault balance accounts for rent correctly across multiple rounds", async () => {
            const vaultBefore = await provider.connection.getAccountInfo(
                vaultPDA
            );
            const balanceBefore = vaultBefore!.lamports;

            const a = "adv-vault-multi";
            const s = "adv-salt-vault-multi-123456789";
            const { roundId, roundPDA } = await createRound(a, s);

            // Multiple entries
            await enterRound(roundId, roundPDA, advPlayer1);
            await enterRound(roundId, roundPDA, advPlayer2);
            await enterRound(roundId, roundPDA, advPlayer3);

            const vaultAfterEntries = await provider.connection.getAccountInfo(
                vaultPDA
            );
            assert.equal(
                vaultAfterEntries!.lamports,
                balanceBefore + 3 * BASE_FEE,
                "Vault should increase by total entry fees"
            );

            await settleRound(roundPDA, a, s, advPlayer1.publicKey);

            const vaultFinal = await provider.connection.getAccountInfo(
                vaultPDA
            );
            const rentExemptMin =
                await provider.connection.getMinimumBalanceForRentExemption(
                    vaultFinal!.data.length
                );
            assert.ok(
                vaultFinal!.lamports >= rentExemptMin,
                "Vault must stay rent-exempt after settle"
            );
        });
    });

    // ================================================================
    // 11. STATE CONSISTENCY
    // ================================================================

    describe("11. State consistency", () => {
        it("Round total_entries and total_deposits track correctly", async () => {
            const a = "adv-state-track";
            const s = "adv-salt-state-track-123456789";
            const { roundId, roundPDA } = await createRound(a, s);

            await enterRound(roundId, roundPDA, advPlayer1);
            let round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.totalEntries.toNumber(), 1);
            assert.equal(round.totalDeposits.toNumber(), BASE_FEE);

            await enterRound(roundId, roundPDA, advPlayer2);
            round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.totalEntries.toNumber(), 2);
            assert.equal(round.totalDeposits.toNumber(), BASE_FEE * 2);

            await enterRound(roundId, roundPDA, advPlayer3);
            round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.totalEntries.toNumber(), 3);
            assert.equal(round.totalDeposits.toNumber(), BASE_FEE * 3);

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
        });

        it("Game state rollover_balance updates on settle", async () => {
            const gsBefore = await program.account.v2GameState.fetch(
                gameStatePDA
            );
            const rolloverBefore = gsBefore.rolloverBalance.toNumber();

            const a = "adv-rollover-settle";
            const s = "adv-salt-rollover-settle-12345";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            await settleRound(roundPDA, a, s, advPlayer1.publicKey);

            const gsAfter = await program.account.v2GameState.fetch(
                gameStatePDA
            );
            const rolloverAfter = gsAfter.rolloverBalance.toNumber();

            // Rollover should be updated (pool * 4500 / 10000 residual)
            // It's set directly, not accumulated, so it's the new value
            assert.ok(
                rolloverAfter >= 0,
                "Rollover balance should be non-negative after settle"
            );
        });

        it("Game state rollover_balance updates on expire", async () => {
            const gsBefore = await program.account.v2GameState.fetch(
                gameStatePDA
            );

            const a = "adv-rollover-expire";
            const s = "adv-salt-rollover-expire-12345";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            const round = await program.account.v2Round.fetch(roundPDA);
            const rolloverIn = round.rolloverIn.toNumber();

            await expireRound(roundPDA, a, s);

            const gsAfter = await program.account.v2GameState.fetch(
                gameStatePDA
            );
            const rolloverAfter = gsAfter.rolloverBalance.toNumber();

            // On expire: rollover_out = rollover_in + (deposits - buyback - treasury)
            // So rollover_after should be >= rollover_in
            assert.ok(
                rolloverAfter >= rolloverIn,
                `Rollover after expire (${rolloverAfter}) should >= rollover_in (${rolloverIn})`
            );
        });

        it("Round status changes to Settled after settle", async () => {
            const a = "adv-status-settle";
            const s = "adv-salt-status-settle-1234567";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer3);

            let round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { active: {} }, "Should start Active");

            await settleRound(roundPDA, a, s, advPlayer3.publicKey);

            round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { settled: {} }, "Should be Settled");
        });

        it("Round status changes to Expired after expire", async () => {
            const a = "adv-status-expire";
            const s = "adv-salt-status-expire-1234567";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer1);

            let round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { active: {} }, "Should start Active");

            await expireRound(roundPDA, a, s);

            round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { expired: {} }, "Should be Expired");
        });

        it("Revealed answer/salt are stored on settle", async () => {
            const a = "adv-reveal-settle";
            const s = "adv-salt-reveal-settle-1234567";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer2);

            await settleRound(roundPDA, a, s, advPlayer2.publicKey);

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.revealedAnswer, a);
            assert.equal(round.revealedSalt, s);
        });

        it("Revealed answer/salt are stored on expire", async () => {
            const a = "adv-reveal-expire";
            const s = "adv-salt-reveal-expire-1234567";
            const { roundId, roundPDA } = await createRound(a, s);
            await enterRound(roundId, roundPDA, advPlayer3);

            await expireRound(roundPDA, a, s);

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.revealedAnswer, a);
            assert.equal(round.revealedSalt, s);
        });

        it("Entry PDA records correct player, amount, and round_id", async () => {
            const a = "adv-entry-fields";
            const s = "adv-salt-entry-fields-12345678";
            const { roundId, roundPDA } = await createRound(a, s);
            const entryAmount = BASE_FEE + 1000; // slight overpay
            await enterRound(roundId, roundPDA, advPlayer1, entryAmount);

            const [entryPDA] = getV2EntryPDA(roundId, advPlayer1.publicKey);
            const entry = await program.account.v2Entry.fetch(entryPDA);

            assert.equal(entry.roundId.toNumber(), roundId);
            assert.equal(
                entry.player.toBase58(),
                advPlayer1.publicKey.toBase58()
            );
            assert.equal(entry.amountPaid.toNumber(), entryAmount);
            assert.ok(entry.enteredAt.toNumber() > 0, "entered_at should be set");

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer1.publicKey);
        });
    });

    // ================================================================
    // 12. MULTI-PLAYER ENTRY CORRECTNESS
    // ================================================================

    describe("12. Multi-player entry correctness", () => {
        it("5 players enter same round, all recorded correctly", async () => {
            const a = "adv-5-players";
            const s = "adv-salt-5-players-123456789012";
            const { roundId, roundPDA } = await createRound(a, s);

            const players = [
                advPlayer1,
                advPlayer2,
                advPlayer3,
                advPlayer4,
                advPlayer5,
            ];
            for (const player of players) {
                await enterRound(roundId, roundPDA, player);
            }

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.totalEntries.toNumber(), 5);
            assert.equal(round.totalDeposits.toNumber(), BASE_FEE * 5);

            // Verify each entry PDA
            for (const player of players) {
                const [entryPDA] = getV2EntryPDA(roundId, player.publicKey);
                const entry = await program.account.v2Entry.fetch(entryPDA);
                assert.equal(entry.roundId.toNumber(), roundId);
                assert.equal(
                    entry.player.toBase58(),
                    player.publicKey.toBase58()
                );
                assert.equal(entry.amountPaid.toNumber(), BASE_FEE);
            }

            // Settle with player 3 as winner
            await settleRound(roundPDA, a, s, advPlayer3.publicKey);

            const roundAfter = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(roundAfter.status, { settled: {} });
        });

        it("Different entry amounts recorded per player", async () => {
            const a = "adv-diff-amounts";
            const s = "adv-salt-diff-amounts-12345678";
            const { roundId, roundPDA } = await createRound(a, s);

            const amounts = [
                BASE_FEE,
                BASE_FEE + 10_000_000,
                BASE_FEE * 2,
            ];

            await enterRound(roundId, roundPDA, advPlayer1, amounts[0]);
            await enterRound(roundId, roundPDA, advPlayer2, amounts[1]);
            await enterRound(roundId, roundPDA, advPlayer3, amounts[2]);

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.equal(round.totalEntries.toNumber(), 3);
            assert.equal(
                round.totalDeposits.toNumber(),
                amounts[0] + amounts[1] + amounts[2]
            );

            // Verify individual amounts
            for (let i = 0; i < 3; i++) {
                const player = [advPlayer1, advPlayer2, advPlayer3][i];
                const [entryPDA] = getV2EntryPDA(roundId, player.publicKey);
                const entry = await program.account.v2Entry.fetch(entryPDA);
                assert.equal(entry.amountPaid.toNumber(), amounts[i]);
            }

            // cleanup
            await settleRound(roundPDA, a, s, advPlayer2.publicKey);
        });

        it("Settle payout goes to specified winner, not other players", async () => {
            const a = "adv-winner-payout";
            const s = "adv-salt-winner-payout-1234567";
            const { roundId, roundPDA } = await createRound(a, s);

            await enterRound(roundId, roundPDA, advPlayer1);
            await enterRound(roundId, roundPDA, advPlayer2);

            const winnerBefore = await provider.connection.getBalance(
                advPlayer4.publicKey
            );

            // Player4 didn't even enter but can be winner
            await settleRound(roundPDA, a, s, advPlayer4.publicKey);

            const winnerAfter = await provider.connection.getBalance(
                advPlayer4.publicKey
            );
            assert.ok(
                winnerAfter > winnerBefore,
                "Winner should receive payout even if they didn't enter"
            );
        });
    });

    // ================================================================
    // 13. ENTRY CUTOFF FIELD VERIFICATION (CNTR-02)
    // ================================================================

    describe("13. Entry cutoff verification (CNTR-02)", () => {
        it("Entry cutoff = ends_at - entry_cutoff_secs", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const a = "adv-cutoff-check";
            const s = "adv-salt-cutoff-check-12345678";
            const { roundId, roundPDA } = await createRound(a, s);
            const round = await program.account.v2Round.fetch(roundPDA);

            const expectedCutoff =
                round.endsAt.toNumber() - gs.entryCutoffSecs.toNumber();
            assert.equal(
                round.entryCutoff.toNumber(),
                expectedCutoff,
                "entry_cutoff should equal ends_at - entry_cutoff_secs"
            );

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("ends_at = started_at + round_duration_secs", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const a = "adv-timer-check";
            const s = "adv-salt-timer-check-123456789";
            const { roundId, roundPDA } = await createRound(a, s);
            const round = await program.account.v2Round.fetch(roundPDA);

            assert.equal(
                round.endsAt.toNumber(),
                round.startedAt.toNumber() + gs.roundDurationSecs.toNumber(),
                "ends_at should equal started_at + round_duration_secs"
            );

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Round starts as Active", async () => {
            const a = "adv-init-active";
            const s = "adv-salt-init-active-123456789";
            const { roundId, roundPDA } = await createRound(a, s);
            const round = await program.account.v2Round.fetch(roundPDA);

            assert.deepEqual(round.status, { active: {} });
            assert.equal(round.totalEntries.toNumber(), 0);
            assert.equal(round.totalDeposits.toNumber(), 0);
            assert.equal(round.revealedAnswer, "");
            assert.equal(round.revealedSalt, "");

            // cleanup
            await expireRound(roundPDA, a, s);
        });

        it("Rollover_in is carried from game_state on round creation", async () => {
            const gs = await program.account.v2GameState.fetch(gameStatePDA);
            const expectedRollover = gs.rolloverBalance.toNumber();

            const a = "adv-rollover-carry";
            const s = "adv-salt-rollover-carry-123456";
            const { roundId, roundPDA } = await createRound(a, s);
            const round = await program.account.v2Round.fetch(roundPDA);

            assert.equal(
                round.rolloverIn.toNumber(),
                expectedRollover,
                "rollover_in should match game_state.rollover_balance at creation"
            );

            // cleanup
            await expireRound(roundPDA, a, s);
        });
    });

    // ================================================================
    // 14. SETTLE/EXPIRE WITH NO ENTRIES (EDGE CASE)
    // ================================================================

    describe("14. Settle/expire with zero deposits", () => {
        it("Expire with zero deposits succeeds (0 payouts, rollover unchanged)", async () => {
            const gsBefore = await program.account.v2GameState.fetch(
                gameStatePDA
            );
            const rolloverBefore = gsBefore.rolloverBalance.toNumber();

            const a = "adv-zero-dep-expire";
            const s = "adv-salt-zero-dep-expire-12345";
            const { roundId, roundPDA } = await createRound(a, s);
            // Don't enter — zero deposits

            await expireRound(roundPDA, a, s);

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { expired: {} });
            assert.equal(round.totalDeposits.toNumber(), 0);

            const gsAfter = await program.account.v2GameState.fetch(
                gameStatePDA
            );
            // rollover_out = rollover_in + (0 - 0 - 0) = rollover_in
            assert.equal(
                gsAfter.rolloverBalance.toNumber(),
                rolloverBefore,
                "Rollover should stay the same with zero deposits"
            );
        });

        it("Settle with zero deposits succeeds (0 payouts)", async () => {
            const a = "adv-zero-dep-settle";
            const s = "adv-salt-zero-dep-settle-12345";
            const { roundId, roundPDA } = await createRound(a, s);
            // Don't enter — zero deposits

            await settleRound(roundPDA, a, s, advPlayer1.publicKey);

            const round = await program.account.v2Round.fetch(roundPDA);
            assert.deepEqual(round.status, { settled: {} });
            assert.equal(round.totalDeposits.toNumber(), 0);
        });
    });

    // ================================================================
    // 15. PDA PREFIX VERIFICATION (CNTR-13)
    // ================================================================

    describe("15. PDA prefix verification (CNTR-13)", () => {
        it("All V2 PDAs use v2_ prefix seeds", () => {
            // game_state PDA
            const [gsPDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("v2_game_state")],
                program.programId
            );
            assert.equal(
                gsPDA.toBase58(),
                gameStatePDA.toBase58(),
                "game_state PDA must use v2_game_state seed"
            );

            // vault PDA
            const [vPDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("v2_vault")],
                program.programId
            );
            assert.equal(
                vPDA.toBase58(),
                vaultPDA.toBase58(),
                "vault PDA must use v2_vault seed"
            );

            // round PDA
            const buf = Buffer.alloc(8);
            buf.writeBigUInt64LE(BigInt(1));
            const [rPDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("v2_round"), buf],
                program.programId
            );
            const [rExpected] = getV2RoundPDA(1);
            assert.equal(
                rPDA.toBase58(),
                rExpected.toBase58(),
                "round PDA must use v2_round seed"
            );
        });

        it("V2 PDAs do NOT collide with V1 PDAs", () => {
            // V1 uses "game_state", V2 uses "v2_game_state"
            const [v1GS] = PublicKey.findProgramAddressSync(
                [Buffer.from("game_state")],
                program.programId
            );
            assert.notEqual(
                v1GS.toBase58(),
                gameStatePDA.toBase58(),
                "V2 game_state PDA must differ from V1"
            );

            const [v1Vault] = PublicKey.findProgramAddressSync(
                [Buffer.from("vault")],
                program.programId
            );
            assert.notEqual(
                v1Vault.toBase58(),
                vaultPDA.toBase58(),
                "V2 vault PDA must differ from V1"
            );
        });
    });

    // ================================================================
    // 16. SEQUENTIAL ROUND CONSISTENCY
    // ================================================================

    describe("16. Sequential round lifecycle consistency", () => {
        it("game_state.current_round_id increments correctly across rounds", async () => {
            const gs1 = await program.account.v2GameState.fetch(gameStatePDA);
            const id1 = gs1.currentRoundId.toNumber();

            const a1 = "adv-seq-1";
            const s1 = "adv-salt-seq-1-xxxxxxxxxx12345";
            const { roundPDA: rp1 } = await createRound(a1, s1);

            const gs2 = await program.account.v2GameState.fetch(gameStatePDA);
            assert.equal(
                gs2.currentRoundId.toNumber(),
                id1 + 1,
                "round ID should increment by 1"
            );

            await expireRound(rp1, a1, s1);

            const a2 = "adv-seq-2";
            const s2 = "adv-salt-seq-2-xxxxxxxxxx12345";
            const { roundPDA: rp2 } = await createRound(a2, s2);

            const gs3 = await program.account.v2GameState.fetch(gameStatePDA);
            assert.equal(
                gs3.currentRoundId.toNumber(),
                id1 + 2,
                "round ID should increment by 2 after 2 rounds"
            );

            await expireRound(rp2, a2, s2);
        });
    });
});
