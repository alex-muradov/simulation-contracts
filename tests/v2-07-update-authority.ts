import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AlonsBoxV2 } from "../target/types/alons_box_v2";
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * V2 update_game_authority tests
 *
 * Tests rotating game_state.authority. This is the in-contract authority
 * (signs settle/expire/create_round), distinct from upgrade_authority.
 *
 * Allows hot-key rotation without redeploying the program.
 */
describe("alons-box-v2 update_game_authority", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
    const originalAuthority = (provider.wallet as anchor.Wallet).payer;

    let gameStatePDA: PublicKey;

    before(async () => {
        [gameStatePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("v2_game_state")],
            program.programId,
        );
    });

    it("rejects update from non-authority signer", async () => {
        const impostor = Keypair.generate();
        const newAuthority = Keypair.generate();

        try {
            await program.methods
                .updateGameAuthority(newAuthority.publicKey)
                .accounts({
                    authority: impostor.publicKey,
                    gameState: gameStatePDA,
                })
                .signers([impostor])
                .rpc();
            assert.fail("expected Unauthorized error");
        } catch (err: any) {
            // Either Anchor's constraint error or solana's missing-signer/sig-verify
            const msg = err.toString();
            assert.match(
                msg,
                /Unauthorized|signature verification failed|unknown signer/i,
                `unexpected error: ${msg}`,
            );
        }
    });

    it("rotates authority and back, verifying both directions", async () => {
        const before = await program.account.v2GameState.fetch(gameStatePDA);
        assert.equal(
            before.authority.toBase58(),
            originalAuthority.publicKey.toBase58(),
            "test precondition: current authority must be the test wallet",
        );

        const newAuthority = Keypair.generate();

        // Rotate to new authority
        await program.methods
            .updateGameAuthority(newAuthority.publicKey)
            .accounts({
                authority: originalAuthority.publicKey,
                gameState: gameStatePDA,
            })
            .rpc();

        const afterRotate = await program.account.v2GameState.fetch(gameStatePDA);
        assert.equal(
            afterRotate.authority.toBase58(),
            newAuthority.publicKey.toBase58(),
            "authority should be new pubkey",
        );

        // Old authority should now be rejected
        try {
            await program.methods
                .updateGameAuthority(originalAuthority.publicKey)
                .accounts({
                    authority: originalAuthority.publicKey,
                    gameState: gameStatePDA,
                })
                .rpc();
            assert.fail("expected old authority to be rejected after rotation");
        } catch (err: any) {
            assert.match(err.toString(), /Unauthorized/, `expected Unauthorized, got: ${err}`);
        }

        // Fund new authority for tx fees
        const sig = await provider.connection.requestAirdrop(
            newAuthority.publicKey,
            anchor.web3.LAMPORTS_PER_SOL,
        );
        await provider.connection.confirmTransaction(sig);

        // Rotate back so subsequent test files (in this suite) keep working
        await program.methods
            .updateGameAuthority(originalAuthority.publicKey)
            .accounts({
                authority: newAuthority.publicKey,
                gameState: gameStatePDA,
            })
            .signers([newAuthority])
            .rpc();

        const afterRollback = await program.account.v2GameState.fetch(gameStatePDA);
        assert.equal(
            afterRollback.authority.toBase58(),
            originalAuthority.publicKey.toBase58(),
            "authority should be back to original",
        );
    });
});
