# Backend Integration

## Overview

The backend is responsible for:

1. Generating answers and computing commit hashes
2. Creating rounds on-chain
3. Receiving player guesses
4. Settling or expiring rounds on-chain

## Setup

### Install the Anchor client

```bash
npm install @coral-xyz/anchor @solana/web3.js
```

### Initialize the client

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AlonsBox } from "./types/alons_box"; // Generated types
import idl from "./idl/alons_box.json";       // Generated IDL
import * as crypto from "crypto";

// Configuration
const PROGRAM_ID = new PublicKey("J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa");
const RPC_URL = "https://api.devnet.solana.com";

// Load authority keypair (keep this secure!)
const authorityKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("authority-keypair.json", "utf8")))
);

// Create provider
const connection = new Connection(RPC_URL, "confirmed");
const wallet = new anchor.Wallet(authorityKeypair);
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});

// Create program instance
const program = new Program<AlonsBox>(idl as any, provider);
```

### Derive PDAs

```typescript
const [gameStatePDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("game_state")],
  PROGRAM_ID
);

const [vaultPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault")],
  PROGRAM_ID
);

function getRoundPDA(roundId: number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), buf],
    PROGRAM_ID
  )[0];
}

function getDepositPDA(roundId: number, user: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit"), buf, user.toBuffer()],
    PROGRAM_ID
  )[0];
}
```

## Round Lifecycle

### 1. Create a Round

```typescript
function computeCommitHash(answer: string, salt: string): Buffer {
  const input = `${answer}:${salt}`;
  return crypto.createHash("sha256").update(input).digest();
}

function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}

async function createRound(roundId: number, answer: string): Promise<string> {
  const salt = generateSalt();
  const commitHash = computeCommitHash(answer, salt);
  const endsAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour deadline
  const roundPDA = getRoundPDA(roundId);

  const tx = await program.methods
    .createRound(
      new anchor.BN(roundId),
      Array.from(commitHash),
      new anchor.BN(endsAt)
    )
    .accounts({
      authority: authorityKeypair.publicKey,
      gameState: gameStatePDA,
      round: roundPDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // IMPORTANT: Store the salt securely -- you need it for settlement
  // Store in your database: { roundId, answer, salt, commitHash }

  return salt;
}
```

### 2. Settle a Round (Winner Found)

```typescript
async function settleRound(
  roundId: number,
  answer: string,
  salt: string,
  winnerPubkey: PublicKey,
  evidenceWallets: PublicKey[],
  evidenceAmounts: number[]
): Promise<string> {
  const roundPDA = getRoundPDA(roundId);

  const remainingAccounts = evidenceWallets.map((pubkey) => ({
    pubkey,
    isWritable: true,
    isSigner: false,
  }));

  const tx = await program.methods
    .settle(
      answer,
      salt,
      evidenceAmounts.map((a) => new anchor.BN(a))
    )
    .accounts({
      authority: authorityKeypair.publicKey,
      gameState: gameStatePDA,
      round: roundPDA,
      vault: vaultPDA,
      winner: winnerPubkey,
      treasury: treasuryPubkey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  return tx;
}
```

### 3. Expire a Round (No Winner)

```typescript
async function expireRound(
  roundId: number,
  answer: string,
  salt: string
): Promise<string> {
  const roundPDA = getRoundPDA(roundId);

  const tx = await program.methods
    .expire(answer, salt)
    .accounts({
      authority: authorityKeypair.publicKey,
      gameState: gameStatePDA,
      round: roundPDA,
      vault: vaultPDA,
      treasury: treasuryPubkey,
      buybackWallet: buybackPubkey,
    })
    .rpc();

  return tx;
}
```

### 4. Donate to the Pool (V2 only, permissionless)

```typescript
async function donate(
  donor: anchor.web3.Keypair,
  amountSol: number
): Promise<string> {
  const amount = new BN(amountSol * LAMPORTS_PER_SOL);

  const tx = await program.methods
    .donate(amount)
    .accounts({
      donor: donor.publicKey,
      gameState: gameStatePDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
    })
    .signers([donor])
    .rpc();

  return tx;
}

// Anyone can call this -- not just the authority. The donated SOL is added
// to game_state.rollover_balance and becomes part of the next round's pool.
// Mid-round donations are preserved through settle/expire.
await donate(sponsorKeypair, 0.5);
```

## Reading On-Chain State

### Fetch Game State

```typescript
const gameState = await program.account.gameState.fetch(gameStatePDA);
console.log("Current round:", gameState.currentRoundId.toNumber());
console.log("Authority:", gameState.authority.toString());
console.log("Treasury:", gameState.treasury.toString());
```

### Fetch Round Data

```typescript
const roundPDA = getRoundPDA(roundId);
const round = await program.account.round.fetch(roundPDA);

console.log("Status:", round.status);
console.log("Total deposits:", round.totalDeposits.toNumber());
console.log("Rollover in:", round.rolloverIn.toNumber());
console.log("Commit hash:", Buffer.from(round.commitHash).toString("hex"));

if (round.status.settled || round.status.expired) {
  console.log("Revealed answer:", round.revealedAnswer);
  console.log("Revealed salt:", round.revealedSalt);
}
```

### Fetch Player Deposit

```typescript
const depositPDA = getDepositPDA(roundId, playerPubkey);
try {
  const deposit = await program.account.deposit.fetch(depositPDA);
  console.log("Player deposit:", deposit.amount.toNumber(), "lamports");
} catch {
  console.log("Player has not deposited in this round");
}
```

### Get Vault Balance

```typescript
const vaultBalance = await connection.getBalance(vaultPDA);
const rentExempt = await connection.getMinimumBalanceForRentExemption(9); // Vault size
const availablePool = vaultBalance - rentExempt;
console.log("Vault total:", vaultBalance, "lamports");
console.log("Available pool:", availablePool, "lamports");
```

## Evidence Amount Calculation

When settling a round, the backend must calculate evidence amounts that sum to at most 30% of the pool:

```typescript
function calculateEvidenceAmounts(
  poolLamports: number,
  evidenceProviders: { wallet: PublicKey; share: number }[] // share = 0-1
): { wallets: PublicKey[]; amounts: number[] } {
  const maxEvidence = Math.floor(poolLamports * 3000 / 10000); // 30% cap
  const totalShares = evidenceProviders.reduce((sum, p) => sum + p.share, 0);

  const wallets: PublicKey[] = [];
  const amounts: number[] = [];

  for (const provider of evidenceProviders) {
    const amount = Math.floor(maxEvidence * provider.share / totalShares);
    wallets.push(provider.wallet);
    amounts.push(amount);
  }

  // Verify we're under the cap
  const totalEvidence = amounts.reduce((sum, a) => sum + a, 0);
  if (totalEvidence > maxEvidence) {
    throw new Error("Evidence amounts exceed 30% cap");
  }

  return { wallets, amounts };
}
```

## Error Handling

```typescript
import { AnchorError } from "@coral-xyz/anchor";

try {
  await settleRound(roundId, answer, salt, winner, [], []);
} catch (err) {
  if (err instanceof AnchorError) {
    switch (err.error.errorCode.number) {
      case 6000:
        console.error("Unauthorized -- check authority keypair");
        break;
      case 6001:
        console.error("Round not active -- already settled/expired");
        break;
      case 6002:
        console.error("Invalid commit hash -- answer/salt mismatch");
        break;
      case 6003:
        console.error("Evidence amounts exceed 30% cap");
        break;
      default:
        console.error("Contract error:", err.error.errorMessage);
    }
  } else {
    console.error("Transaction error:", err);
  }
}
```

## Security Notes

- **Never expose the authority keypair** in client-side code or public repositories
- **Store salts securely** -- if you lose a salt, you cannot settle or expire the round
- **Validate winner addresses** before calling settle to avoid sending funds to invalid accounts
- **Use confirmed commitment** level for reading state to ensure data is finalized
