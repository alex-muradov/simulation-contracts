# Contract Addresses

## Alon's Box (V1)

| Field | Value |
|-------|-------|
| Program ID | `J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa` |
| Network | Solana Devnet |
| Explorer | [View on Solana Explorer](https://explorer.solana.com/address/J5LMxDvUSz5Agbo3bjpJZN17p4BNfqGNbrhU5vqNYrEa?cluster=devnet) |

### PDA Accounts

| Account | Seeds | Purpose |
|---------|-------|---------|
| GameState | `["game_state"]` | Global config: authority, treasury, round counter |
| Vault | `["vault"]` | Singleton SOL escrow |
| Round | `["round", round_id]` | Per-round state |
| Deposit | `["deposit", round_id, user_pubkey]` | Per-user deposit tracking |

See [PDA Accounts](../developers/contracts/alons-box/pda-accounts.md) for full derivation details and field layouts.

## Alon's Box V2

| Field | Value |
|-------|-------|
| Program ID | `21XdvvE67SYnRLLcLkFDTXMSkbLrJNh6Ndi5qe5ErZwg` |
| Network | Solana Devnet |
| Explorer | [View on Solana Explorer](https://explorer.solana.com/address/21XdvvE67SYnRLLcLkFDTXMSkbLrJNh6Ndi5qe5ErZwg?cluster=devnet) |

### PDA Accounts

| Account | Seeds | Purpose |
|---------|-------|---------|
| V2GameState | `["v2_game_state"]` | Global config: authority, treasury, buyback wallet, round counter, rollover |
| V2Vault | `["v2_vault"]` | Singleton SOL escrow |
| V2Round | `["v2_round", round_id]` | Per-round state: deposits, evidence tracking, commit hash |
| V2Entry | `["v2_entry", round_id, player_pubkey]` | Per-player entry and fee paid |
| V2Evidence | `["v2_evidence", round_id, wallet_pubkey]` | Per-wallet YES answer count for evidence claims |

See [PDA Accounts](../developers/contracts/alons-box-v2/pda-accounts.md) for full derivation details and field layouts.

## Two Pills

| Field | Value |
|-------|-------|
| Program ID | `7SbPUmDW8L44k7KRbxpMo7hBh4ocpv9kszpWz5iNPJLW` |
| Network | Solana Devnet |
| Explorer | [View on Solana Explorer](https://explorer.solana.com/address/7SbPUmDW8L44k7KRbxpMo7hBh4ocpv9kszpWz5iNPJLW?cluster=devnet) |
