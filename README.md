# GasRun — Arc Testnet

Lane-runner arcade game on **Arc Testnet** with weekly leaderboard, permanent USDC balances, and instant USDC withdraw via smart contract.

## Network

| | |
|---|---|
| Chain | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | https://testnet.arcscan.app |
| USDC (ERC-20, 6 dec) | `0x3600000000000000000000000000000000000000` |
| Faucet | https://faucet.circle.com |

## Features

- Play → save points (25% decay every 10 min if not deposited/converted)
- **Deposit** saved points → weekly leaderboard (Neon + optional on-chain score log)
- **Convert** points → permanent USDC (`1000 pts = 1 USDC`)
- **Withdraw** permanent USDC to wallet (no minimum, instant via vault contract)
- **Admin** at `/admin` (wallet-gated)

## Admin

Only wallet: `0xe8Bda2Ed9d2FC622D900C8a76dc455A3e79B041f`

## Setup

```bash
npm install
# .env already has DATABASE_URL + deployer key (see DEPLOY_KEYS.md)
npm run init:db
```

### Deploy contracts (one-time)

1. Fund deployer from Circle Faucet (address in `DEPLOY_KEYS.md`)
2. `npm run deploy:contracts`
3. Set `VAULT_ADDRESS` + `SCORE_ADDRESS` in `.env` and `contracts-config.js`
4. Fund vault by sending Arc USDC to the vault address

### Run locally

```bash
npx vercel dev
# or any static server + serverless for /api
```

### Vercel env

```
DATABASE_URL=...
OPERATOR_PRIVATE_KEY=...
DEPLOYER_PRIVATE_KEY=...
VAULT_ADDRESS=...
SCORE_ADDRESS=...
ADMIN_ADDRESS=0xe8Bda2Ed9d2FC622D900C8a76dc455A3e79B041f
ARC_RPC_URL=https://rpc.testnet.arc.network
USDC_ADDRESS=0x3600000000000000000000000000000000000000
```

## Economy

| Action | Rule |
|--------|------|
| Convert | 1000 points → 1 permanent USDC |
| Withdraw | no minimum, instant on-chain to user wallet |
| Leaderboard | deposit saved points for weekly ranking |
| Penalty | -25% saved points every 10 minutes if not saved to LB / USDC |

## Project layout

```
api/           serverless (user, convert, withdraw, deposit, leaderboard, admin)
admin/         admin panel UI
contracts/     GasRunVault + GasRunScore
scripts/       deploy + db init
src/main.js    game + wallet + Arc flows
```

## Docs used

- https://docs.arc.io/build
- https://docs.arc.io/arc/references/connect-to-arc
- https://docs.arc.io/arc/references/contract-addresses
- https://developers.circle.com/
