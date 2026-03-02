/// <reference types="node" />
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AlonsBox } from "../target/types/alons_box";
import { SystemProgram } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AlonsBox as Program<AlonsBox>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  const [gameStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_state")],
    program.programId
  );

  process.stdout.write("Program ID: " + program.programId.toBase58() + "\n");
  process.stdout.write("Authority: " + authority.publicKey.toBase58() + "\n");
  process.stdout.write("GameState PDA: " + gameStatePDA.toBase58() + "\n");

  const accountInfo = await provider.connection.getAccountInfo(gameStatePDA);
  process.stdout.write("Current account size: " + (accountInfo?.data.length ?? "null") + " bytes\n");

  const tx = await program.methods
    .migrate()
    .accounts({
      authority: authority.publicKey,
      gameState: gameStatePDA,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  process.stdout.write("Migrate tx: " + tx + "\n");

  const updatedInfo = await provider.connection.getAccountInfo(gameStatePDA);
  process.stdout.write("New account size: " + (updatedInfo?.data.length ?? "null") + " bytes\n");

  const gameState = await program.account.gameState.fetch(gameStatePDA);
  process.stdout.write("rollover_balance: " + gameState.rolloverBalance.toString() + "\n");
  process.stdout.write("current_round_id: " + gameState.currentRoundId.toString() + "\n");
  process.stdout.write("Migration complete!\n");
}

main().catch((e) => { process.stderr.write(e.toString() + "\n"); process.exit(1); });
