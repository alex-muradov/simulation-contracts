/// <reference types="node" />
/**
 * Initialize Alon's Box V2 on devnet.
 *
 * Creates the V2GameState and V2Vault PDAs. Run once after first deploy.
 *
 * Usage:
 *   solana config set --url devnet
 *   npx ts-node --esm scripts/init-v2.ts
 *
 * Or via Anchor:
 *   anchor run init-v2 --provider.cluster devnet
 *
 * Environment:
 *   Uses the wallet at ~/.config/solana/id.json (same as anchor deploy).
 *   Treasury and buyback default to the authority wallet if not set via env vars.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AlonsBoxV2 } from "../target/types/alons_box_v2";
import { PublicKey, SystemProgram } from "@solana/web3.js";

// Defaults matching the contract constants
const ROUND_DURATION_SECS = 1200; // 20 minutes
const ENTRY_CUTOFF_SECS = 180;    // 3 minutes before end

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AlonsBoxV2 as Program<AlonsBoxV2>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  // Treasury and buyback wallets — override via env or default to authority
  const treasury = process.env.TREASURY_PUBKEY
    ? new PublicKey(process.env.TREASURY_PUBKEY)
    : authority.publicKey;

  const buybackWallet = process.env.BUYBACK_PUBKEY
    ? new PublicKey(process.env.BUYBACK_PUBKEY)
    : authority.publicKey;

  // Derive PDAs
  const [gameStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("v2_game_state")],
    program.programId,
  );
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("v2_vault")],
    program.programId,
  );

  // Check if already initialized
  const existing = await provider.connection.getAccountInfo(gameStatePDA);
  if (existing) {
    process.stdout.write("V2 GameState already exists — fetching current state...\n\n");
    const gs = await program.account.v2GameState.fetch(gameStatePDA);
    process.stdout.write("  Program ID:        " + program.programId.toBase58() + "\n");
    process.stdout.write("  Authority:         " + gs.authority.toBase58() + "\n");
    process.stdout.write("  Treasury:          " + gs.treasury.toBase58() + "\n");
    process.stdout.write("  Buyback Wallet:    " + gs.buybackWallet.toBase58() + "\n");
    process.stdout.write("  Current Round ID:  " + gs.currentRoundId.toString() + "\n");
    process.stdout.write("  Rollover Balance:  " + gs.rolloverBalance.toString() + " lamports\n");
    process.stdout.write("  Round Duration:    " + gs.roundDurationSecs.toString() + "s\n");
    process.stdout.write("  Entry Cutoff:      " + gs.entryCutoffSecs.toString() + "s\n");
    process.stdout.write("\nAlready initialized. No action taken.\n");
    return;
  }

  process.stdout.write("=== Alon's Box V2 — Initialize ===\n\n");
  process.stdout.write("  Program ID:        " + program.programId.toBase58() + "\n");
  process.stdout.write("  Authority:         " + authority.publicKey.toBase58() + "\n");
  process.stdout.write("  Treasury:          " + treasury.toBase58() + "\n");
  process.stdout.write("  Buyback Wallet:    " + buybackWallet.toBase58() + "\n");
  process.stdout.write("  Round Duration:    " + ROUND_DURATION_SECS + "s (20 min)\n");
  process.stdout.write("  Entry Cutoff:      " + ENTRY_CUTOFF_SECS + "s (3 min before end)\n");
  process.stdout.write("  GameState PDA:     " + gameStatePDA.toBase58() + "\n");
  process.stdout.write("  Vault PDA:         " + vaultPDA.toBase58() + "\n\n");

  const tx = await program.methods
    .initialize(
      treasury,
      buybackWallet,
      new anchor.BN(ROUND_DURATION_SECS),
      new anchor.BN(ENTRY_CUTOFF_SECS),
    )
    .accounts({
      authority: authority.publicKey,
      gameState: gameStatePDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  process.stdout.write("  TX Signature:      " + tx + "\n\n");

  // Verify
  const gs = await program.account.v2GameState.fetch(gameStatePDA);
  process.stdout.write("  ✅ V2 initialized!\n");
  process.stdout.write("  Rollover Balance:  " + gs.rolloverBalance.toString() + " lamports\n");
  process.stdout.write("  Current Round ID:  " + gs.currentRoundId.toString() + "\n");
}

main().catch((e) => {
  process.stderr.write("Error: " + e.toString() + "\n");
  process.exit(1);
});
