<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=180&section=header&text=GasRun&fontSize=52&fontColor=fff&animation=twinkling&fontAlignY=32&desc=Onchain%20car%20game%20deployed%20on%20Base%20network&descAlignY=55&descSize=14" width="100%" />

</div>

<div align="center">

**`// ðŸŽ® GasRun â€” Onchain car game deployed on Base network`**

> *"Short, skill-based micro-sessions. Save points often, commit weekly on-chain."*

</div>

---

## `{ what_it_does }`

GasRun is an onchain car game built as a Farcaster mini app on the Base network. Players navigate a lane-runner-style game in short, skill-based micro-sessions, accumulate points, and commit their scores permanently to the Base blockchain. A global leaderboard tracks weekly and all-time champions, fully sourced from onchain contract logs.

---

## `{ tech_stack }`

<div align="center">

**â—† LANGUAGES**

![JavaScript](https://img.shields.io/badge/JavaScript-B8F0D8?style=for-the-badge&logo=javascript&logoColor=1a1a1a)
![HTML5](https://img.shields.io/badge/HTML5-B3D9FF?style=for-the-badge&logo=html5&logoColor=1a1a1a)
![CSS3](https://img.shields.io/badge/CSS3-FFF4A8?style=for-the-badge&logo=css3&logoColor=1a1a1a)

**â—† WEB3 & BLOCKCHAIN**

![Base](https://img.shields.io/badge/Base-FFD4A8?style=for-the-badge&logo=coinbase&logoColor=1a1a1a)
![Viem](https://img.shields.io/badge/Viem-FFB3D9?style=for-the-badge&logo=ethereum&logoColor=1a1a1a)
![Solidity](https://img.shields.io/badge/Solidity-FFB3B3?style=for-the-badge&logo=solidity&logoColor=1a1a1a)
![Farcaster](https://img.shields.io/badge/Farcaster_MiniApp-D4B3FF?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBhdGggZmlsbD0iIzE3MTcxNyIgZD0iTTE2IDBDNy4xNiAwIDAgNy4xNiAwIDE2czguMTYgMTYgMTYgMTYgMTYtNy4xNiAxNi0xNlMyNC44NCAwIDE2IDB6Ii8+PC9zdmc+&logoColor=1a1a1a)

**â—† TOOLS & BACKEND**

![Vercel](https://img.shields.io/badge/Vercel-B8F0D8?style=for-the-badge&logo=vercel&logoColor=1a1a1a)
![Upstash Redis](https://img.shields.io/badge/Upstash_Redis-B3D9FF?style=for-the-badge&logo=redis&logoColor=1a1a1a)
![WalletConnect](https://img.shields.io/badge/WalletConnect-FFF4A8?style=for-the-badge&logo=walletconnect&logoColor=1a1a1a)
![js-sha3](https://img.shields.io/badge/js--sha3-FFD4A8?style=for-the-badge&logo=npm&logoColor=1a1a1a)

</div>

---

## `{ features }`

![](https://img.shields.io/badge/FEAT-Lane_Runner_Car_Game_(browser,_no_install)-B8F0D8?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-Farcaster_Mini_App_(playable_inside_Warpcast)-B3D9FF?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-Onchain_Score_Commits_on_Base_Mainnet-FFF4A8?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-Weekly_%26_All--time_Global_Leaderboard-FFD4A8?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-WalletConnect_%2B_Injected_Wallet_Support-FFB3D9?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-ERC--8021_Builder_Attribution-FFB3B3?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-Paymaster_/_Gasless_Transaction_Support-D4B3FF?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-Redis--cached_Leaderboard_(instant_load)-B8F0D8?style=flat-square&labelColor=1a1a1a)

![](https://img.shields.io/badge/FEAT-Live_at_gasrun.online-B3D9FF?style=flat-square&labelColor=1a1a1a)

---

## `{ quick_start }`

```bash
git clone https://github.com/0xnurrabby/GasRun
cd GasRun
npm install
npm run dev
```

> **Required env vars** â€” create a `.env` file:

```env
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
NEYNAR_API_KEY=your_neynar_key        # optional, for FC usernames on leaderboard
MAINTENANCE_MODE=false
MAINTENANCE_BYPASS_KEY=your_secret    # optional
```

> **Deploy to Vercel:**

```bash
# Push to GitHub â†’ Import in vercel.com
# Vercel serves static files directly â€” no build step needed
# All game logic is in src/main.js (vanilla JS, zero bundler required)
```

> **Play live:**

```
https://www.gasrun.online
```

---

## `{ project_structure }`

```
GasRun/
|-- api/
|   |-- leaderboard.js     # Weekly/all-time leaderboard (onchain + Redis cache)
|   |-- paymaster.js       # Gasless tx paymaster endpoint
|   |-- share.js           # Share card generator
|   +-- cron/              # Scheduled leaderboard cache refresh
|-- src/
|   |-- main.js            # Full game engine + wallet + onchain logic
|   +-- styles.css         # Game UI styles
|-- assets/                # Game sprites, icons, OG images
|-- .well-known/           # Farcaster app manifest
|-- index.html             # Mini App entry point
|-- maintenance.html       # Maintenance page
|-- middleware.js          # Vercel edge middleware
+-- package.json
```

---

## `{ connect }`

<div align="center">

[![X (Twitter)](https://img.shields.io/badge/X_(Twitter)-@nurw3b-B8F0D8?style=for-the-badge&logo=x&logoColor=1a1a1a&labelColor=1a1a1a)](https://x.com/nurw3b)

[![Telegram](https://img.shields.io/badge/Telegram-@nurrabby-B3D9FF?style=for-the-badge&logo=telegram&logoColor=1a1a1a&labelColor=1a1a1a)](https://t.me/nurrabby)

[![GitHub](https://img.shields.io/badge/GitHub-0xnurrabby-FFD4A8?style=for-the-badge&logo=github&logoColor=1a1a1a&labelColor=1a1a1a)](https://github.com/0xnurrabby)

</div>

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=100&section=footer" width="100%" />

</div>
