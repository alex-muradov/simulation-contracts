import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TwoPills } from "../target/types/two_pills";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const TREASURY = new PublicKey("GHHJDnccPpkGjP7WkAHZrNwVyAuBP3oHKM9JzAugpY8x");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TwoPills as Program<TwoPills>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  console.log("Program ID:", program.programId.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Treasury:", TREASURY.toBase58());

  // Derive PDAs
  const [gameStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pills_state")],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pills_vault")],
    program.programId
  );

  console.log("GameState PDA:", gameStatePda.toBase58());
  console.log("Vault PDA:", vaultPda.toBase58());

  // Check if already initialized
  try {
    const existing = await program.account.pillsGameState.fetch(gameStatePda);
    console.log("\nAlready initialized!");
    console.log("  Authority:", existing.authority.toBase58());
    console.log("  Treasury:", existing.treasury.toBase58());
    console.log("  NRR Balance:", existing.nrrBalance.toNumber());
    console.log("  Round Counter:", existing.roundCounter.toNumber());
    return;
  } catch {
    // Not initialized yet — proceed
  }

  console.log("\nInitializing...");

  const tx = await program.methods
    .initialize(TREASURY)
    .accounts({
      authority: authority.publicKey,
      gameState: gameStatePda,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  console.log("TX:", tx);

  // Verify
  const gs = await program.account.pillsGameState.fetch(gameStatePda);
  console.log("\nInitialized successfully!");
  console.log("  Authority:", gs.authority.toBase58());
  console.log("  Treasury:", gs.treasury.toBase58());
  console.log("  NRR Balance:", gs.nrrBalance.toNumber());
  console.log("  Round Counter:", gs.roundCounter.toNumber());
  console.log("  Bump:", gs.bump);
}

main().catch(console.error);
