# Alon's Box V2

A trustless crypto-AI guessing game on Solana. An AI hides a **two-word phrase** (e.g., "pink cat"), and players compete to identify it by entering the round, asking questions, and submitting guesses.

## How to Play

1. **A round opens** — The AI generates a secret two-word phrase and commits its hash on-chain
2. **Enter the round** — Pay an escalating entry fee to join (cheaper early, more expensive later)
3. **Ask questions** — Ask Yes/No questions (public or private) for free after entry
4. **Submit guesses** — Guess the phrase for free (requires 3+ questions asked, 2+ public)
5. **Round resolves** — Either someone guesses correctly or the timer expires
6. **Collect payouts** — Winner, YES pool contributors, and protocol receive SOL from the vault

Entry is the only payment. Once you are in a round, all questions and guesses are free.

**Optional: Donate to the pool.** Anyone — players, spectators, or sponsors — can donate any amount of SOL at any time using the permissionless `donate` instruction. Donations are added directly to rollover and are preserved through both settle and expire (they never flow to buyback or treasury). See [Donations](donations.md).

## End Conditions

| Condition | What Happens |
|-----------|-------------|
| Correct guess (settle) | 50% winner, 30% rollover, 15% YES pool, 5% treasury |
| Timer expires (expire) | 47.5% buyback, 47.5% rollover, 5% treasury (from deposits only) |

## Program ID

```
21XdvvE67SYnRLLcLkFDTXMSkbLrJNh6Ndi5qe5ErZwg
```

Deployed on **Solana Devnet**. [View on Explorer](https://explorer.solana.com/address/21XdvvE67SYnRLLcLkFDTXMSkbLrJNh6Ndi5qe5ErZwg?cluster=devnet)

## Further Reading

- [Entry Fees](entry-fees.md) — Escalating entry fee system and strategy
- [Evidence and YES Pool](evidence-and-yes-pool.md) — YES pool distribution and evidence mechanics
- [Rounds](rounds.md) — Round lifecycle, state machine, end conditions
- [Donations](donations.md) — Permissionless pool contributions via the `donate` instruction
