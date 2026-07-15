/**
 * STARTUP OPTIMIZATION
 * - Render the game immediately (no remote ESM imports at module-eval time).
 * - Mini App SDK is loaded via <script defer ...> in index.html.
 * - Heavy web3 deps (viem + ox) are loaded lazily while the user is already playing.
 */
function _getSdkSync() {
  return (
    (window.miniapp && window.miniapp.sdk) ||
    (window.frame && window.frame.sdk) ||
    window.sdk ||
    null
  );
}
let sdk = _getSdkSync();
let _sdkWaitPromise = null;

async function ensureSdk(timeoutMs = 12000) {
  if (sdk) return sdk;
  if (_sdkWaitPromise) return _sdkWaitPromise;
  _sdkWaitPromise = new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      sdk = _getSdkSync();
      if (sdk) return resolve(sdk);
      if (performance.now() - start > timeoutMs) return reject(new Error("Mini App SDK not available"));
      setTimeout(poll, 10);
    })();
  });
  return _sdkWaitPromise;
}

// Lazy web3 deps (only needed for connect/commit/chain ops)
let Attribution = null;
let encodeAbiParameters = null;
let encodeFunctionData = null;

// Warm status for "Deposit Saved points" button.
// Goal: game renders instantly, but deposit becomes usable ASAP in the background.
let web3WarmReady = false;
let web3WarmPromise = null;

let _viemPromise = null;
async function ensureViem() {
  if (encodeAbiParameters && encodeFunctionData) return;
  _viemPromise = _viemPromise || import("https://esm.sh/viem@2.21.0");
  const m = await _viemPromise;
  encodeAbiParameters = m.encodeAbiParameters;
  encodeFunctionData = m.encodeFunctionData;
}

let dataSuffix = null;
let _oxPromise = null;
async function ensureAttribution() {
  if (dataSuffix) return;
  // Pin the ox version so ERC-8021 attribution doesn't randomly break
  // due to CDN/upstream package updates.
  _oxPromise = _oxPromise || import("https://esm.sh/ox@0.12.1/erc8021");
  const m = await _oxPromise;
  Attribution = m.Attribution;
  // BUILDER_CODE is defined below (hard input)
  dataSuffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });
}

// =====================================================
// WALLETCONNECT (v2) — mobile browser QR / deep-link wallet support
// Lazy-loaded only when user actually picks WalletConnect.
// =====================================================
// 👇👇👇 IMPORTANT: put your WalletConnect (Reown) Project ID here.
// Get one free at https://cloud.reown.com  (takes 1 minute)
const WALLETCONNECT_PROJECT_ID = "ba001bb517511dfef37a6d2b8839d8eb";

let _wcProviderPromise = null;
let _wcProvider = null;

async function getWalletConnectProvider() {
  if (_wcProvider) return _wcProvider;
  if (_wcProviderPromise) return _wcProviderPromise;

  _wcProviderPromise = (async () => {
    if (!WALLETCONNECT_PROJECT_ID || WALLETCONNECT_PROJECT_ID === "REPLACE_WITH_YOUR_PROJECT_ID") {
      throw new Error("WalletConnect Project ID not set. Get one at https://cloud.reown.com");
    }

    // Load WalletConnect Ethereum Provider from CDN (ESM)
    const mod = await import("https://esm.sh/@walletconnect/ethereum-provider@2.17.0");
    const EthereumProvider = mod.EthereumProvider || mod.default?.EthereumProvider || mod.default;

    const provider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      chains: [5042002], // Arc Testnet
      optionalChains: [5042002],
      showQrModal: true,
      qrModalOptions: {
        themeMode: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
        themeVariables: {
          "--wcm-z-index": "9999",
          "--wcm-accent-color": "#ff6b35",
          "--wcm-background-color": "#0d0d14"
        }
      },
      metadata: {
        name: "GasRun",
        description: "Onchain arcade racer on Arc Testnet",
        url: typeof window !== "undefined" ? window.location.origin : "https://gasrun.online",
        icons: ["https://gasrun.online/assets/icon.png"]
      },
      rpcMap: {
        5042002: "https://rpc.testnet.arc.network"
      }
    });

    // Bridge events so the rest of the app gets account/chain change notifications.
    try {
      provider.on("accountsChanged", (accs) => {
        account = accs?.[0] || null;
        if (!account) {
          ethProvider = null;
          activeWalletId = null;
          activeWalletLabel = "Arc";
        }
        try { renderStatus(); } catch {}
      });
      provider.on("disconnect", () => {
        if (activeWalletId === "walletconnect") {
          account = null;
          ethProvider = null;
          activeWalletId = null;
          activeWalletLabel = "Arc";
          try { renderStatus(); } catch {}
          try { toast("Wallet disconnected"); } catch {}
        }
      });
    } catch {}

    _wcProvider = provider;
    return provider;
  })();

  try {
    return await _wcProviderPromise;
  } catch (e) {
    _wcProviderPromise = null; // allow retry
    throw e;
  }
}

async function disconnectWalletConnectIfAny() {
  try {
    if (_wcProvider && typeof _wcProvider.disconnect === "function") {
      await _wcProvider.disconnect();
    }
  } catch {}
  _wcProvider = null;
  _wcProviderPromise = null;
}

// One shared "warm" promise so clicks feel instant even if the deps are still loading.
function warmWeb3Deps() {
  if (web3WarmReady) return Promise.resolve();
  web3WarmPromise =
    web3WarmPromise ||
    Promise.all([ensureAttribution(), ensureViem()])
      .then(() => {
        web3WarmReady = true;
      })
      .catch(() => {
        // Keep the game running even if warmup fails; commit will show a real error later.
      });
  return web3WarmPromise;
}

// Kick off background loading *after first paint* (doesn't block UI)
function prefetchWeb3Deps() {
  const start = () => {
    // fire-and-forget; keep UI responsive
    warmWeb3Deps();
  };
  // Prefer idle time so first render stays snappy, but don't wait too long.
  if ("requestIdleCallback" in window) {
    // @ts-ignore
    requestIdleCallback(start, { timeout: 300 });
  } else {
    requestAnimationFrame(() => setTimeout(start, 60));
  }
}

// =====================================================
// HARD INPUTS
// =====================================================
const TOP_TITLE = "👈🏻Click for m0re Dear";
const HUD_TITLE = "Live Statistics";
const HOME_URL = "https://www.gasrun.online/";

// =====================================================
// THEME SWITCHER (Light / Dark) — persists in localStorage
// =====================================================
const THEME_KEY = "gasrun_theme_v1";

function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {}
  return "light"; // default = LIGHT (day mode) as user requested
}

function setTheme(theme) {
  const t = theme === "dark" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  document.documentElement.setAttribute("data-theme", t);
  // Force a single repaint so canvas picks up new palette instantly
  if (typeof window !== "undefined") {
    requestAnimationFrame(() => {
      try { if (typeof render === "function") render(); } catch {}
    });
  }
}

// Apply saved theme ASAP (before first paint)
(function _applySavedThemeEarly() {
  try {
    const t = getTheme();
    document.documentElement.setAttribute("data-theme", t);
  } catch {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();

// Read current canvas palette from CSS variables (keeps JS & CSS in sync)
function getCanvasPalette() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    skyTop:    get("--cv-sky-top",    "#fef6e4"),
    skyMid:    get("--cv-sky-mid",    "#f8e9c1"),
    skyBot:    get("--cv-sky-bot",    "#ffd59b"),
    asphalt1:  get("--cv-asphalt-1",  "#3a3a4a"),
    asphalt2:  get("--cv-asphalt-2",  "#4a4a5c"),
    asphaltDot:get("--cv-asphalt-dot","#5d5d72"),
    roadShadow:get("--cv-road-shadow","rgba(30,20,10,0.25)"),
    roadStroke:get("--cv-road-stroke","#0d0d14"),
    laneOutl:  get("--cv-lane-outline","rgba(13,13,20,0.9)"),
    laneDash:  get("--cv-lane-dash",  "#f7d046"),
    edgeLeft:  get("--cv-edge-left",  "#f7d046"),
    edgeRight: get("--cv-edge-right", "#ff6b35"),
    streakA:   get("--cv-streak-a",   "rgba(255,107,53,0.35)"),
    streakB:   get("--cv-streak-b",   "rgba(247,208,70,0.45)"),
    sideFill1: get("--cv-side-1",     "#e8dcb5"),
    sideFill2: get("--cv-side-2",     "#d4c489"),
    sideFill3: get("--cv-side-3",     "#bfaf73"),
    sideAccent:get("--cv-side-accent","#ff6b35"),
    ink:       get("--ink",           "#0d0d14"),
    hazardYel: get("--cv-hazard",     "#f7d046"),
    overlay:   get("--cv-overlay",    "rgba(10,10,15,0.55)"),
    bannerBg:  get("--cv-banner-bg",  "#fef6e4"),
    bannerSh:  get("--cv-banner-sh",  "#ff6b35"),
    bannerTtl: get("--cv-banner-ttl", "#ef476f"),
    bannerTxt: get("--cv-banner-txt", "#0d0d14"),
    bannerSub: get("--cv-banner-sub", "#ff6b35"),
  };
}

function colorizeMinecraftText(str) {
  // digits + common symbols => red
  const re = /[0-9$+*\-%=]/g;
  return String(str).replace(re, (m) => `<span class="mcRed">${m}</span>`);
}

let crashAnimStart = 0;
let wasGameOver = false;

let weekCountdownRAF = 0;
let weekCountdownActive = false;

// Arc Testnet
const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_ID_HEX = "0x4cf152";
const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_EXPLORER = "https://testnet.arcscan.app";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
// GasRunCore — every movement is an on-chain transaction
const CORE_CONTRACT =
  (window.__GASRUN_CONTRACTS && (window.__GASRUN_CONTRACTS.core || window.__GASRUN_CONTRACTS.vault)) ||
  "0x3d61d1083f53A431899b800b12B5e1ff4fD256de";
const SCORE_CONTRACT = CORE_CONTRACT;
const VAULT_CONTRACT = CORE_CONTRACT;
const CONTRACT = CORE_CONTRACT;
const POINTS_PER_USDC = 1000;
const MIN_WITHDRAW_USDC = 0.1;

const CORE_FN = {
  saveRun: {
    type: "function",
    name: "saveRun",
    stateMutability: "nonpayable",
    inputs: [{ name: "points", type: "uint256" }],
    outputs: []
  },
  depositScore: {
    type: "function",
    name: "depositScore",
    stateMutability: "nonpayable",
    inputs: [
      { name: "points", type: "uint256" },
      { name: "weekStart", type: "uint256" }
    ],
    outputs: []
  },
  convert: {
    type: "function",
    name: "convert",
    stateMutability: "nonpayable",
    inputs: [
      { name: "points", type: "uint256" },
      { name: "usdcMicros", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" }
    ],
    outputs: []
  },
  withdraw: {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "usdcMicros", type: "uint256" }],
    outputs: []
  }
};

// Builder Code (optional attribution)
const BUILDER_CODE = "bc_ox3c2ez4";
/* dataSuffix is computed lazily via ensureAttribution() */
// On-chain action name (bytes32)
function _stringToBytes32Hex(str) {
  const enc = new TextEncoder();
  const bytes = enc.encode(String(str));
  if (bytes.length > 32) throw new Error("bytes32 overflow");
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  hex += "00".repeat(32 - bytes.length);
  return "0x" + hex;
}

// On-chain action name (bytes32)
const ACTION_WEEKLY_ADD = _stringToBytes32Hex("WEEKLY_ADD");

// Event ABI
// Event ABI (lazy-parse if needed later)
const ACTION_LOGGED_EVENT_ABI = "event ActionLogged(address indexed user, bytes32 indexed action, uint256 timestamp, bytes data)";
let ACTION_LOGGED_EVENT = null;
// =====================================================
// UI
// =====================================================
const app = document.getElementById("app");
app.innerHTML = `
  <div class="shell">
    <div class="topbar">
      <button class="iconBtn" id="menuBtn" aria-label="Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="title mcFont">${colorizeMinecraftText(TOP_TITLE)}</div>
      <button class="badge" id="statusBadge">Loading…</button>
    </div>

    <div class="gameCard">
      <div class="canvasWrap">
        <canvas id="c"></canvas>

        <!-- Compact floating HUD (transparent, minimal) -->
        <div class="hudMini" id="hud">
          <div class="hudMiniRow"><span class="hudK">RUN</span><b id="runScore">0</b></div>
          <div class="hudMiniRow"><span class="hudK">COINS</span><b id="coins">0</b></div>
          <div class="hudMiniRow"><span class="hudK">BANK</span><b id="bankPoints">0</b></div>
          <div class="hudMiniRow"><span class="hudK">BOOST</span><b id="boost">—</b></div>
        </div>

        <div class="toast" id="toast"></div>
      </div>
    </div>

    <div class="bottomBar">
      <div class="controls">
        <button class="ctrlBtn" id="leftBtn" aria-label="Move Left">
          <span class="ctrlIcon">◀</span><span class="ctrlText">Left</span>
        </button>
        <button class="ctrlBtn primary" id="saveBtn" aria-label="Save Points">
          <span class="ctrlText">💾Save</span>
        </button>
        <button class="ctrlBtn" id="rightBtn" aria-label="Move Right">
          <span class="ctrlText">Right</span><span class="ctrlIcon">▶</span>
        </button>
      </div>
    </div>

    <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="sheetPanel">
        <div class="sheetHeader">
          <h3 id="sheetTitle">Menu</h3>
          <button class="iconBtn" id="closeSheet" aria-label="Close">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="sheetBody" id="sheetBody"></div>
      </div>
    </div>
  </div>
`;

const els = {
  statusBadge: $("#statusBadge"),
  sheet: $("#sheet"),
  sheetTitle: $("#sheetTitle"),
  sheetBody: $("#sheetBody"),
  toast: $("#toast"),
  c: $("#c"),
  runScore: $("#runScore"),
  coins: $("#coins"),
  bankPoints: $("#bankPoints"),
  boost: $("#boost"),
  menuBtn: $("#menuBtn"),
  closeSheet: $("#closeSheet"),
  leftBtn: $("#leftBtn"),
  rightBtn: $("#rightBtn"),
  saveBtn: $("#saveBtn")
};

function $(sel) {
  return document.querySelector(sel);
}

function toast(msg, ms = 1800) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}

// =====================================================
// Audio + Haptics (coin sfx, background music, vibration)
// Notes:
// - Mobile browsers block autoplay. We "unlock" audio on the first user gesture.
// - Vibration is best-effort (only works where supported).
// =====================================================
const AUDIO = {
  unlocked: false,
  coinPool: [],
  coinIdx: 0,
  bgm: null
};

function setupAudio() {
  if (AUDIO.coinPool.length) return;

  // Coin SFX pool (allows rapid consecutive plays)
  for (let i = 0; i < 5; i++) {
    const a = new Audio("/assets/coin.mp3");
    a.preload = "auto";
    a.volume = 0.20; // ✅ 50% lower than 0.40
    AUDIO.coinPool.push(a);
  }

  // Background music
  AUDIO.bgm = new Audio("/assets/bgm.mp3");
  AUDIO.bgm.preload = "auto";
  AUDIO.bgm.loop = true;
  AUDIO.bgm.volume = 0.32;
}

async function ensureAudioUnlocked() {
  setupAudio();
  if (AUDIO.unlocked) return;

  try {
    // Attempt a silent play/pause to unlock audio on iOS/Android.
    const a = AUDIO.coinPool[0];
    a.muted = true;
    await a.play();
    a.pause();
    a.currentTime = 0;
    a.muted = false;
    AUDIO.unlocked = true;
  } catch {
    AUDIO.unlocked = false;
  }

  if (AUDIO.unlocked) startBgm();
}

function startBgm() {
  setupAudio();
  if (!AUDIO.unlocked || !AUDIO.bgm) return;
  if (!AUDIO.bgm.paused) return;

  AUDIO.bgm.currentTime = 0;
  AUDIO.bgm.play().catch(() => {});
}

function stopBgm() {
  if (!AUDIO.bgm) return;
  try {
    AUDIO.bgm.pause();
  } catch {}
}

function playCoinSfx() {
  if (!AUDIO.unlocked || !AUDIO.coinPool.length) return;
  const a = AUDIO.coinPool[AUDIO.coinIdx % AUDIO.coinPool.length];
  AUDIO.coinIdx++;
  try {
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {}
}

function vibrate(pattern) {
  // 1) Standard Web Vibration API (works mostly on Android Chrome, some in-app browsers)
  try {
    if (navigator && typeof navigator.vibrate === "function") {
      return navigator.vibrate(pattern);
    }
  } catch {}

  // 2) Farcaster miniapp SDK fallback (best effort)
  try {
    const p = Array.isArray(pattern) ? pattern[0] : pattern;
    if (sdk?.actions?.haptics?.impact) {
      const type = p >= 60 ? "medium" : "light";
      (sdk || _getSdkSync())?.actions?.haptics?.impact?.(type);
      return true;
    }
    if (sdk?.actions?.haptics?.notification) {
      (sdk || _getSdkSync())?.actions?.haptics?.notification?.("success");
      return true;
    }
  } catch {}

  return false;
}

// ✅ Missing functions added
function hapticTap() {
  vibrate(12);
}
function crashVibe() {
  vibrate([55, 30, 55]);
}

// =====================================================
// Mini App READY (MANDATORY)
// - called ASAP from index.html when SDK loads (to hide splash)
// - we also attempt here as a fallback (non-blocking)
// =====================================================
(async () => {
  try {
    els.statusBadge.textContent = "Connect";
    const s = await ensureSdk();
    // idempotent in hosts; safe to call twice
    await s.actions.ready({ disableNativeGestures: true });
  } catch {
    // don't block game if SDK isn't present (e.g., opened in normal browser)
    els.statusBadge.textContent = "Connect";
  }
})();

// Start background loading of heavy deps while the user plays
prefetchWeb3Deps();

// =====================================================
// Wallet / Chain
// =====================================================
let ethProvider = null;
let account = null;
let activeWalletId = null;
let activeWalletLabel = "Arc";
let miniAppProviderPromise = null;
const injectedWallets = new Map();

function normalizeWalletLabel(label, fallback = "Browser Wallet") {
  const v = String(label || "").trim();
  return v || fallback;
}

function registerInjectedWallet(provider, info = {}) {
  if (!provider || typeof provider.request !== "function") return;
  const uuid = info.uuid || info.rdns || info.name || `wallet-${injectedWallets.size + 1}`;
  const name =
    info.name ||
    (provider.isMetaMask && "MetaMask") ||
    (provider.isCoinbaseWallet && "Coinbase Wallet") ||
    (provider.isRabby && "Rabby") ||
    "Browser Wallet";
  injectedWallets.set(uuid, {
    id: uuid,
    label: normalizeWalletLabel(name),
    provider,
    rdns: info.rdns || null
  });
}

function setupInjectedWalletDiscovery() {
  try {
    window.addEventListener("eip6963:announceProvider", (event) => {
      const detail = event?.detail || {};
      registerInjectedWallet(detail.provider, detail.info || {});
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {}

  try {
    const eth = window.ethereum;
    if (eth?.providers && Array.isArray(eth.providers)) {
      for (const provider of eth.providers) registerInjectedWallet(provider);
    }
    if (eth) registerInjectedWallet(eth);
  } catch {}
}

setupInjectedWalletDiscovery();

function listInjectedWalletOptions() {
  const items = Array.from(injectedWallets.values());
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

function bindProviderEvents(provider) {
  if (!provider || typeof provider.on !== "function") return;
  if (provider.__gasRunEventsBound) return;
  provider.__gasRunEventsBound = true;

  provider.on("accountsChanged", (accs) => {
    account = accs?.[0] || null;
    if (!account) {
      ethProvider = null;
      activeWalletId = null;
      activeWalletLabel = "Arc";
    }
    renderStatus();
  });

  provider.on("disconnect", () => {
    account = null;
    ethProvider = null;
    activeWalletId = null;
    activeWalletLabel = "Arc";
    renderStatus();
  });
}

// Debug / capability detection (EIP-5792)
let _lastWalletCapabilities = null;

/**
 * Try to query wallet capabilities (EIP-5792). Not all wallets implement this.
 * Helps us explain why paymaster sponsorship is not being applied.
 */
async function refreshWalletCapabilities(p) {
  try {
    if (!account) return null;
    const chainId = await p.request({ method: "eth_chainId", params: [] });
    const res = await p.request({
      method: "wallet_getCapabilities",
      // Common signature: [address, [chainIds]]
      params: [account, [chainId]]
    });
    _lastWalletCapabilities = { chainId, res };
    console.log("wallet_getCapabilities:", _lastWalletCapabilities);
    return _lastWalletCapabilities;
  } catch (e) {
    console.warn("wallet_getCapabilities not supported or failed:", e);
    _lastWalletCapabilities = null;
    return null;
  }
}

/**
 * Quick health-check for your /api/paymaster proxy.
 * If this fails, sponsorship will fail even on supported wallets.
 */
async function checkPaymasterProxy() {
  try {
    const r = await fetch("/api/paymaster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
    });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, body: txt.slice(0, 500) };
  } catch (e) {
    return { ok: false, status: 0, body: String(e?.message || e) };
  }
}

async function getMiniAppProvider() {
  miniAppProviderPromise =
    miniAppProviderPromise ||
    (async () => {
      try {
        const s = await ensureSdk();
        const p = await s.wallet.getEthereumProvider();
        if (p) bindProviderEvents(p);
        return p || null;
      } catch {
        return null;
      }
    })();
  return miniAppProviderPromise;
}

async function getProvider(source = "active") {
  if (source === "active" && ethProvider) return ethProvider;

  if (source === "miniapp") {
    const p = await getMiniAppProvider();
    if (p) bindProviderEvents(p);
    return p;
  }

  if (source && source.startsWith("injected:")) {
    const item = injectedWallets.get(source.slice(9)) || null;
    const p = item?.provider || null;
    if (p) bindProviderEvents(p);
    return p;
  }

  if (source === "walletconnect") {
    try {
      const wc = await getWalletConnectProvider();
      // For WalletConnect, events are already bridged inside getWalletConnectProvider.
      return wc;
    } catch (e) {
      toast(e?.message || "WalletConnect unavailable", 3000);
      return null;
    }
  }

  if (ethProvider) return ethProvider;


  const mini = await getMiniAppProvider();
  if (mini) {
    bindProviderEvents(mini);
    return mini;
  }

  const injected = listInjectedWalletOptions()[0]?.provider || null;
  if (injected) bindProviderEvents(injected);
  return injected;
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

let fcUsername = null;
let fcFid = null;

function _toStr(v) {
  if (typeof v === "string") return v;
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "object") {
    if (typeof v.username === "string") return v.username;
    if (typeof v.displayName === "string") return v.displayName;
    if (typeof v.name === "string") return v.name;
  }
  return null;
}

async function getFcUsername() {
  if (fcUsername !== null) return fcUsername;
  try {
    const s = await ensureSdk().catch(() => null);
const ctx =
  (s && s.context) ||
  (s && s.actions && (await s.actions.getContext?.())) ||
  null;
    const u = ctx?.user || ctx?.context?.user || null;
    fcUsername = _toStr(u?.username ?? u?.displayName ?? u?.name ?? null);
    fcFid = u?.fid ?? ctx?.fid ?? ctx?.userFid ?? null;
  } catch {
    fcUsername = null;
  }
  return fcUsername;
}

async function getFcFid() {
  if (fcFid !== null) return fcFid;
  await getFcUsername();
  return fcFid;
}

async function displayNameFor(addr) {
  // Try cached mapping first (localStorage). We also sanitize old/bad cached values
  // like "@[object Object]" from earlier builds.
  try {
    const raw = localStorage.getItem("addrNameMap");
    if (raw) {
      const m = JSON.parse(raw);
      const k = String(addr || "").toLowerCase();
      let v = m?.[k];

      // Normalize objects/invalid strings
      if (typeof v === "object" && v) v = v.username || v.displayName || v.name || null;
      if (typeof v === "string") {
        const vv = v.trim();
        const bad = !vv || vv.includes("[object Object]") || vv.length > 80;
        if (!bad) return vv;
        // delete bad cached value so it won't keep showing
        try {
          delete m[k];
          localStorage.setItem("addrNameMap", JSON.stringify(m));
        } catch {}
      }
    }
  } catch {}

  // For the connected account, try Farcaster username (if available)
  if (account && addr && addr.toLowerCase() === account.toLowerCase()) {
    const u = await getFcUsername();
    if (typeof u === "string") {
      const uu = u.trim().replace(/^@+/, "");
      if (uu && !uu.includes("[object Object]")) return `@${uu}`;
    }
  }

  // Fallback: show FULL address (not truncated).
  return addr ? String(addr) : "";
}


function fmtPts(n) {
  const s = (typeof n === "bigint" ? n : BigInt(n || 0)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function renderStatus() {
  if (!account) {
    els.statusBadge.textContent = "Connect";
    return;
  }
  els.statusBadge.textContent = `${shortAddr(account)} (${activeWalletLabel || "Arc"})`;
}

async function cacheConnectedUserLabel() {
  try {
    const u = await getFcUsername();
    if (typeof u === "string" && account) {
      const uu = u.trim().replace(/^@+/, "");
      const raw = localStorage.getItem("addrNameMap");
      const m = raw ? JSON.parse(raw) : {};
      if (uu && !uu.includes("[object Object]")) {
        m[String(account).toLowerCase()] = `@${uu}`;
      } else {
        delete m[String(account).toLowerCase()];
      }
      localStorage.setItem("addrNameMap", JSON.stringify(m));
    }
  } catch {}
}

async function connectWallet(source = "miniapp", walletLabel = null) {
  const p = await getProvider(source);
  if (!p) {
    const msg =
      source === "miniapp"
        ? "Mini app host not detected. Use WalletConnect or install MetaMask."
        : source === "walletconnect"
        ? "WalletConnect unavailable. Check your internet or try again."
        : "No wallet found. Try WalletConnect or install a browser wallet.";
    toast(msg, 2800);
    return null;
  }


  try {
    let accs;
    if (source === "walletconnect") {
      // WalletConnect v2 uses .connect() which triggers the QR modal / deep-link.
      if (typeof p.connect === "function" && !p.accounts?.length) {
        await p.connect();
      }
      accs = p.accounts && p.accounts.length
        ? p.accounts
        : await p.request({ method: "eth_requestAccounts", params: [] });
    } else {
      accs = await p.request({ method: "eth_requestAccounts", params: [] });
    }

    account = accs?.[0] || null;
    ethProvider = p;
    activeWalletId = source;
    activeWalletLabel = normalizeWalletLabel(
      walletLabel || (
        source === "miniapp" ? "Arc" :
        source === "walletconnect" ? "WalletConnect" :
        "Browser Wallet"
      ),
      "Arc"
    );
    try { await ensureArc(); } catch {}
    try { await refreshServerBalance(); } catch {}
    try { refreshWalletCapabilities(p); } catch {}
    await cacheConnectedUserLabel();
    renderStatus();
    return account;
  } catch (e) {
    const code = e?.code;
    if (code === 4001) toast("Wallet connection cancelled.");
    else toast(e?.message || "Wallet connection failed.", 2400);
    // If WalletConnect session failed, cleanup so retry works
    if (source === "walletconnect") {
      try { await disconnectWalletConnectIfAny(); } catch {}
    }
    return null;
  }
}

async function openWalletConnectFlow() {
  warmWeb3Deps();

  // Detect Mini App host FAST with a short timeout — so on a regular
  // mobile browser we don't wait 12s for the SDK that will never arrive.
  const isMiniHost = await detectMiniHostFast();
  const injected = listInjectedWalletOptions();
  const options = [];

  if (isMiniHost) {
    options.push({
      id: "miniapp",
      label: "Arc / Mini App wallet",
      sub: account && activeWalletId === "miniapp"
        ? "Already connected here"
        : "Uses the wallet provided by the host app"
    });
  }

  for (const item of injected) {
    options.push({
      id: `injected:${item.id}`,
      label: item.label,
      sub: item.label === "MetaMask"
        ? "Browser extension / in-app browser"
        : "Injected browser wallet"
    });
  }

  // Only offer WalletConnect if a Project ID is configured.
  // Recommend it when user has no other wallet (typical mobile browser case).
  const wcEnabled =
    WALLETCONNECT_PROJECT_ID &&
    WALLETCONNECT_PROJECT_ID !== "REPLACE_WITH_YOUR_PROJECT_ID";

  if (wcEnabled) {
    options.push({
      id: "walletconnect",
      label: "WalletConnect",
      sub: "Scan QR or open your mobile wallet (MetaMask, Trust, Rainbow, OKX…)",
      recommended: !isMiniHost && injected.length === 0
    });
  }

  if (!options.length) {
    // No wallet at all — give clear actionable hint.
    const installHint = wcEnabled
      ? "No wallet detected. Use WalletConnect, install MetaMask/Coinbase Wallet, or open inside Base/Farcaster."
      : "No wallet detected. Install MetaMask/Coinbase Wallet, or open inside Base/Farcaster.";
    toast(installHint, 3200);
    return;
  }

  const iconFor = (id) => {
    if (id === "walletconnect") return "🔗";
    if (id === "miniapp") return "🟢";
    if (id.startsWith("injected:")) return "🦊";
    return "👛";
  };

  openSheet(
    "Connect wallet",
    `
    <div class="connectWalletSheet">
      <div class="walletOptionList">
        ${options.map((opt) => `
          <button class="walletOption ${opt.recommended ? "recommended" : ""}" data-wallet-id="${opt.id}" data-wallet-label="${opt.label.replace(/"/g, '&quot;')}">
            <span class="walletOptionIcon">${iconFor(opt.id)}</span>
            <span class="walletOptionBody">
              <span class="walletOptionTitle">
                ${opt.label}
                ${opt.recommended ? '<span class="walletRecBadge">Recommended</span>' : ""}
              </span>
              <span class="walletOptionSub">${opt.sub}</span>
            </span>
          </button>
        `).join("")}
      </div>
      <div class="walletHint">
        <b>On mobile browser?</b> Pick <b>WalletConnect</b> — it'll open your installed wallet app (MetaMask, Trust, Rainbow, OKX, etc.) or show a QR to scan.
      </div>
    </div>
  `,
    "wallet-connect"
  );

  document.querySelectorAll("[data-wallet-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const walletId = btn.getAttribute("data-wallet-id") || "miniapp";
      const walletLabel = btn.getAttribute("data-wallet-label") || "Arc";
      btn.disabled = true;
      const connected = await connectWallet(walletId, walletLabel);
      if (connected) openMainMenu();
      else btn.disabled = false;
    });
  });
}

// Fast mini-host detection: checks synchronously first, then waits only 300ms.
// Prevents the 12s ensureSdk() stall on regular mobile browsers.
async function detectMiniHostFast() {
  // synchronous fast path — SDK already present?
  const syncSdk = _getSdkSync();
  if (syncSdk) {
    try {
      const p = await syncSdk.wallet.getEthereumProvider();
      return !!p;
    } catch { return false; }
  }

  // short async wait — if SDK shows up within 300ms, count it.
  try {
    const p = await new Promise((resolve) => {
      const start = performance.now();
      (function poll() {
        const s = _getSdkSync();
        if (s) return resolve(s);
        if (performance.now() - start > 300) return resolve(null);
        setTimeout(poll, 30);
      })();
    });
    if (!p) return false;
    const pr = await p.wallet.getEthereumProvider();
    return !!pr;
  } catch {
    return false;
  }
}


// =====================================================
// ensureArc — Arc Testnet (chainId 5042002 / 0x4cf152)
// =====================================================
async function ensureArc() {
  const p = await getProvider();
  if (!p) throw new Error("No wallet provider. Please reconnect your wallet.");

  let chainId;
  try {
    chainId = await p.request({ method: "eth_chainId", params: [] });
  } catch (e) {
    throw new Error("Wallet session expired. Please reconnect and try again.");
  }

  const normalized = String(chainId || "").toLowerCase();
  if (normalized === ARC_CHAIN_ID_HEX || Number(chainId) === ARC_CHAIN_ID) return;

  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_CHAIN_ID_HEX }]
    });
    return;
  } catch (switchErr) {
    const code = switchErr?.code;
    if (code === 4001) {
      throw new Error("Please switch to Arc Testnet to continue.");
    }
    if (code === 4902 || code === -32602 || code === -32603 || !code) {
      try {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: ARC_CHAIN_ID_HEX,
            chainName: "Arc Testnet",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: [ARC_RPC],
            blockExplorerUrls: [ARC_EXPLORER]
          }]
        });
        try {
          await p.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: ARC_CHAIN_ID_HEX }]
          });
        } catch {}
      } catch (addErr) {
        if (addErr?.code === 4001) {
          throw new Error("Please approve adding Arc Testnet to continue.");
        }
        throw new Error(
          "Could not switch to Arc Testnet. Add network manually (RPC https://rpc.testnet.arc.network, chainId 5042002)."
        );
      }
    } else {
      throw new Error("Network switch failed. Switch to Arc Testnet in your wallet.");
    }
  }

  try {
    const verify = await p.request({ method: "eth_chainId", params: [] });
    if (String(verify).toLowerCase() !== ARC_CHAIN_ID_HEX && Number(verify) !== ARC_CHAIN_ID) {
      throw new Error("Please switch to Arc Testnet in your wallet, then try again.");
    }
  } catch (e) {
    if (String(e?.message || "").includes("Please switch")) throw e;
  }
}

async function signGasrunMessage(message) {
  const p = await getProvider();
  if (!p || !account) throw new Error("Connect wallet first");
  try {
    return await p.request({
      method: "personal_sign",
      params: [message, account]
    });
  } catch (e1) {
    const hex =
      "0x" +
      Array.from(new TextEncoder().encode(message))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return await p.request({
      method: "personal_sign",
      params: [hex, account]
    });
  }
}

/** Send a single on-chain call to GasRunCore (one MetaMask popup) */
async function sendCoreTx(fnAbi, args, statusText = "Confirm transaction…") {
  if (!account) {
    await connectWallet();
    if (!account) throw new Error("Connect wallet first");
  }
  await ensureArc();
  await warmWeb3Deps();
  if (!encodeFunctionData) throw new Error("Web3 not ready");

  const p = await getProvider();
  if (!p) throw new Error("No wallet provider");

  const data = encodeFunctionData({
    abi: [fnAbi],
    functionName: fnAbi.name,
    args
  });

  toast(statusText, 2000);
  const txHash = await p.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: account,
        to: CORE_CONTRACT,
        value: "0x0",
        data
      }
    ]
  });
  return txHash;
}

async function waitTxLight(txHash, timeoutMs = 45000) {
  if (!txHash) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(ARC_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash]
        })
      });
      const j = await res.json();
      if (j?.result) {
        if (j.result.status === "0x0") throw new Error("On-chain transaction failed");
        return j.result;
      }
    } catch (e) {
      if (String(e?.message || "").includes("failed")) throw e;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null; // still pending — caller may continue
}

async function fetchUserServer() {
  if (!account) return null;
  const res = await fetch(`/api/user?address=${account}`, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!j?.ok) return null;
  return j;
}

let serverUsdcBalance = "0.000000";
let serverUsdcMicros = "0";

async function refreshServerBalance() {
  try {
    const j = await fetchUserServer();
    if (j?.user) {
      serverUsdcBalance = j.user.usdcBalance || "0.000000";
      serverUsdcMicros = j.user.usdcBalanceMicros || "0";
      if (typeof j.user.totalDepositedPts === "number") {
        localStorage.setItem(LS_TOTAL_DEPOSITED, String(j.user.totalDepositedPts));
      }
    }
  } catch {}
}

async function convertPointsToUsdc() {
  applyDecay();
  if (!account) {
    await connectWallet();
    if (!account) return;
  }
  const pts = Math.floor(profile.bankPoints);
  if (pts <= 0) {
    toast("No saved points to convert");
    return;
  }
  const usePts = pts;
  const usdcAmt = usePts / POINTS_PER_USDC;
  if (!confirm(`On-chain convert ${usePts} points → ${usdcAmt} USDC?\n(1 wallet transaction)`)) return;

  try {
    toast("Preparing on-chain convert…", 1500);
    const addr = String(account).toLowerCase();
    const prep = await fetch("/api/convert-voucher", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: addr, points: usePts })
    }).then((r) => r.json());
    if (!prep?.ok) throw new Error(prep?.error || "Voucher failed");

    const txHash = await sendCoreTx(
      CORE_FN.convert,
      [BigInt(usePts), BigInt(prep.usdcMicros), BigInt(prep.deadline), prep.signature],
      "Confirm convert on Arc…"
    );
    toast("Waiting for confirmation…", 2000);
    await waitTxLight(txHash);

    const conf = await fetch("/api/convert-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: addr, points: usePts, txHash })
    }).then((r) => r.json());
    if (!conf?.ok) throw new Error(conf?.error || "Confirm failed");

    profile.bankPoints = Math.max(0, profile.bankPoints - usePts);
    persistProfile();
    serverUsdcBalance = conf.usdcBalance;
    serverUsdcMicros = conf.usdcBalanceMicros;
    toast(`On-chain convert ✓ ${conf.usdcAdded} USDC`, 2800);
    openMainMenu();
  } catch (e) {
    const msg = String(e?.message || e || "Convert failed");
    if (/reject|denied|cancel/i.test(msg)) toast("Transaction cancelled");
    else toast(msg, 4000);
  }
}

async function openWithdrawUsdcView() {
  if (!account) {
    await connectWallet();
    if (!account) return;
  }
  await refreshServerBalance();
  const balMicros = BigInt(serverUsdcMicros || "0");
  const minMicros = BigInt(Math.round(MIN_WITHDRAW_USDC * 1_000_000));
  if (balMicros < minMicros) {
    toast(`Permanent USDC is ${serverUsdcBalance} (need ≥ 0.1). Convert points first.`);
    return;
  }

  openSheet(
    "Withdraw USDC",
    `
    <div class="menuGrid">
      <div class="kv"><div class="k">Wallet</div><div class="v">${shortAddr(account)}</div></div>
      <div class="kv"><div class="k">Permanent USDC</div><div class="v">${serverUsdcBalance}</div></div>
      <div class="kv"><div class="k">Min withdraw</div><div class="v">0.1 USDC</div></div>
      <div class="kv"><div class="k">Network</div><div class="v">Arc Testnet</div></div>
    </div>
    <label class="fieldLabel" for="wdAmountInput">How much USDC to withdraw?</label>
    <div class="wdInputRow">
      <input id="wdAmountInput" class="wdInput" type="number" inputmode="decimal" min="0.1" step="0.1" placeholder="0.1" value="" />
      <button class="pill" type="button" id="btnWdMax">MAX</button>
    </div>
    <div class="btnRow">
      <button class="pill" type="button" id="btnWdBack">Back</button>
      <button class="pill primary" type="button" id="btnWdConfirm">Withdraw to wallet</button>
    </div>
    <p class="mutedNote">Instant on-chain payout to your connected wallet.</p>
    `,
    "withdraw"
  );

  const input = $("#wdAmountInput");
  if (input) {
    input.value = "";
    setTimeout(() => {
      try { input.focus(); } catch {}
    }, 50);
  }

  $("#btnWdMax")?.addEventListener("click", () => {
    if (input) input.value = String(serverUsdcBalance);
  });
  $("#btnWdBack")?.addEventListener("click", () => openMainMenu());
  $("#btnWdConfirm")?.addEventListener("click", async () => {
    await confirmWithdrawUsdc(input?.value);
  });
}

async function confirmWithdrawUsdc(rawAmount) {
  await refreshServerBalance();
  const balMicros = BigInt(serverUsdcMicros || "0");
  const amount = Math.round(Number(rawAmount) * 1e6) / 1e6;
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAW_USDC) {
    toast("Enter amount (min 0.1 USDC)");
    return;
  }
  const usdcMicros = String(Math.round(amount * 1_000_000));
  if (BigInt(usdcMicros) > balMicros) {
    toast(`Max is ${serverUsdcBalance} USDC`);
    return;
  }

  const btn = $("#btnWdConfirm");
  const prev = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Withdrawing…";
  }

  try {
    const addr = String(account).toLowerCase();
    // User sends withdraw() on GasRunCore — real on-chain USDC to wallet
    const txHash = await sendCoreTx(
      CORE_FN.withdraw,
      [BigInt(usdcMicros)],
      "Confirm withdraw on Arc…"
    );
    toast("Waiting for confirmation…", 2000);
    await waitTxLight(txHash);

    const j = await fetch("/api/withdraw-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: addr, usdcMicros, txHash })
    }).then((r) => r.json());
    if (!j?.ok) throw new Error(j?.error || "Sync failed");

    serverUsdcBalance = j.usdcBalance;
    serverUsdcMicros = j.usdcBalanceMicros || "0";
    toast(`On-chain withdraw ✓ ${j.amount} USDC`, 2800);
    if (j.explorer) console.log("tx", j.explorer);
    await openMainMenu();
  } catch (e) {
    const msg = String(e?.message || e || "Withdraw failed");
    if (/reject|denied|cancel/i.test(msg)) toast("Transaction cancelled");
    else toast(msg, 4000);
    if (btn) {
      btn.disabled = false;
      btn.textContent = prev || "Withdraw to wallet";
    }
  }
}

// keep old name for any callers
async function withdrawUsdc() {
  return openWithdrawUsdcView();
}

// =====================================================
// Time windows (Weekly reset) + Boost rhythm
// =====================================================
function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 Sun..6 Sat
  const diffToMon = (day + 6) % 7; // days since Monday
  const mon = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0)
  );
  return mon.getTime();
}

function weekIdUtc(now = Date.now()) {
  return new Date(weekStartUtcMs(now)).toISOString().slice(0, 10);
}
function weekEndUtcMs(now = Date.now()) {
  return weekStartUtcMs(now) + 7 * 24 * 60 * 60 * 1000;
}

function fmtCountdown(ms) {
  ms = Math.max(0, ms);
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const hr = totalHr % 24;
  const days = Math.floor(totalHr / 24);
  const pad = (n) => String(n).padStart(2, "0");
  return days > 0
    ? `${days}d ${pad(hr)}:${pad(min)}:${pad(sec)}`
    : `${pad(hr)}:${pad(min)}:${pad(sec)}`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function renderSevenSeg(canvas, text, pulse = 1) {
  if (!canvas) return;
  const str = String(text);

  // layout in CSS pixels
  const cssH = 16;                 // height of digits
  const segT = Math.max(2, cssH * 0.18);
  const digitW = cssH * 0.62;
  const gap = cssH * 0.18;
  const colonW = cssH * 0.22;

  const charW = (ch) => {
    if (ch === ":") return colonW + gap;
    if (ch === " ") return gap * 0.8;
    return digitW + gap;
  };

  let cssW = 2; // padding start
  for (const ch of str) cssW += charW(ch);
  cssW += 2; // padding end

  // prepare canvas with DPR scaling
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = cssH + "px";
  canvas.style.width = cssW + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const onTop = "rgba(255,70,70,1)";
  const onBot = "rgba(160,0,0,1)";
  const off = "rgba(255,70,70,0.10)";

  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, onTop);
  grad.addColorStop(1, onBot);

  const litAlpha = 0.78 + 0.22 * pulse;

  function drawSeg(x, y, w, h, lit) {
    roundRectPath(ctx, x, y, w, h, segT * 0.45);
    if (lit) {
      ctx.save();
      ctx.globalAlpha = litAlpha;
      ctx.shadowBlur = 10 + 10 * pulse;
      ctx.shadowColor = "rgba(255,70,70,0.55)";
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = off;
      ctx.fill();
      ctx.restore();
    }
  }

  const DIGITS = {
    "0": ["a", "b", "c", "d", "e", "f"],
    "1": ["b", "c"],
    "2": ["a", "b", "g", "e", "d"],
    "3": ["a", "b", "g", "c", "d"],
    "4": ["f", "g", "b", "c"],
    "5": ["a", "f", "g", "c", "d"],
    "6": ["a", "f", "g", "e", "c", "d"],
    "7": ["a", "b", "c"],
    "8": ["a", "b", "c", "d", "e", "f", "g"],
    "9": ["a", "b", "c", "d", "f", "g"],
    // seven-seg lowercase d: b,c,d,e,g
    "d": ["b", "c", "d", "e", "g"]
  };

  function drawChar(ch, x) {
    if (ch === " ") return x + charW(ch);
    if (ch === ":") {
      const r = segT * 0.45;
      const cx = x + colonW * 0.5;
      const y1 = cssH * 0.35;
      const y2 = cssH * 0.68;

      ctx.save();
      ctx.globalAlpha = 0.75 + 0.25 * pulse;
      ctx.shadowBlur = 8 + 8 * pulse;
      ctx.shadowColor = "rgba(255,70,70,0.45)";
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, y1, r, 0, Math.PI * 2);
      ctx.arc(cx, y2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      return x + charW(ch);
    }

    const segs = DIGITS[ch] || DIGITS["0"];
    const lit = (name) => segs.includes(name);

    const topY = 0;
    const midY = cssH * 0.5;
    const botY = cssH;

    const x0 = x;
    const w = digitW;
    const t = segT;

    // horizontals
    drawSeg(x0 + t, topY + 0.5, w - 2 * t, t, lit("a"));
    drawSeg(x0 + t, midY - t / 2, w - 2 * t, t, lit("g"));
    drawSeg(x0 + t, botY - t - 0.5, w - 2 * t, t, lit("d"));

    // verticals (upper)
    drawSeg(x0 + 0.5, topY + t, t, midY - 1.5 * t, lit("f"));
    drawSeg(x0 + w - t - 0.5, topY + t, t, midY - 1.5 * t, lit("b"));

    // verticals (lower)
    drawSeg(x0 + 0.5, midY + t * 0.5, t, midY - 1.5 * t, lit("e"));
    drawSeg(x0 + w - t - 0.5, midY + t * 0.5, t, midY - 1.5 * t, lit("c"));

    return x + charW(ch);
  }

  let x = 2;
  for (const ch of str) x = drawChar(ch, x);
}

function updateWeekCountdownCanvases(nowPerf) {
  const now = Date.now();
  const remain = weekEndUtcMs(now) - now;

  // Smooth pulse for premium feel
  const pulse = 0.75 + 0.25 * Math.sin(nowPerf / 380);
  const str = remain <= 0 ? "00:00:00" : fmtCountdown(remain);

  const c1 = $("#weekCountdownSeg");
  if (c1) renderSevenSeg(c1, str, pulse);

  const c2 = $("#weekCountdownBoardsSeg");
  if (c2) renderSevenSeg(c2, str, pulse);
}

function tickWeekCountdown(nowPerf) {
  if (!weekCountdownActive) return;
  updateWeekCountdownCanvases(nowPerf);
  weekCountdownRAF = requestAnimationFrame(tickWeekCountdown);
}

function startWeekCountdown() {
  stopWeekCountdown();
  weekCountdownActive = true;
  weekCountdownRAF = requestAnimationFrame(tickWeekCountdown);
}

function stopWeekCountdown() {
  weekCountdownActive = false;
  if (weekCountdownRAF) cancelAnimationFrame(weekCountdownRAF);
  weekCountdownRAF = 0;
}



function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hoursToMs(h) {
  return h * 60 * 60 * 1000;
}

// =====================================================
// Off-chain Profile: banked points + coins + decay
// =====================================================
const DECAY_INTERVAL_MS = 10 * 60 * 1000;
const DECAY_MULT = 0.75;
// =====================================================
// Leaderboard Access Lock (min 10,000 deposited points to view)
// Deposits continue to be saved on-chain regardless of access.
// The backend leaderboard keeps working — only the VIEW is gated.
// =====================================================
const LEADERBOARD_UNLOCK_THRESHOLD = 10000;
const LS_TOTAL_DEPOSITED = "gasrun_total_deposited";

function getTotalDeposited() {
  return Math.max(0, Number(localStorage.getItem(LS_TOTAL_DEPOSITED) || "0") | 0);
}
function addToTotalDeposited(pts) {
  const n = Math.max(0, Math.floor(Number(pts) || 0));
  const cur = getTotalDeposited();
  const next = cur + n;
  localStorage.setItem(LS_TOTAL_DEPOSITED, String(next));
  return next;
}
function isLeaderboardUnlocked() {
  return getTotalDeposited() >= LEADERBOARD_UNLOCK_THRESHOLD;
}
function getLbProgressPct() {
  return Math.min(100, Math.round((getTotalDeposited() / LEADERBOARD_UNLOCK_THRESHOLD) * 100));
}
function getLbRemaining() {
  return Math.max(0, LEADERBOARD_UNLOCK_THRESHOLD - getTotalDeposited());
}

const profile = {
  bankPoints: Number(localStorage.getItem("w3r_bank") || "0"),
  coins: Number(localStorage.getItem("w3r_coins") || "0"),
  lastDecayAt: Number(localStorage.getItem("w3r_decay_at") || "0"),
  boostReadyAt: Number(localStorage.getItem("w3r_boost_ready_at") || "0"),
  boostActiveUntil: Number(localStorage.getItem("w3r_boost_active_until") || "0"),
  boostMult: 1
};

function persistProfile() {
  localStorage.setItem("w3r_bank", String(Math.floor(profile.bankPoints)));
  localStorage.setItem("w3r_coins", String(Math.floor(profile.coins)));
  localStorage.setItem("w3r_decay_at", String(profile.lastDecayAt));
  localStorage.setItem("w3r_boost_ready_at", String(profile.boostReadyAt));
  localStorage.setItem("w3r_boost_active_until", String(profile.boostActiveUntil));
}

function applyDecay(now = Date.now()) {
  if (!profile.lastDecayAt) {
    profile.lastDecayAt = now;
    persistProfile();
    return;
  }
  if (profile.bankPoints <= 0) {
    profile.lastDecayAt = now;
    persistProfile();
    return;
  }

  const elapsed = now - profile.lastDecayAt;
  if (elapsed < DECAY_INTERVAL_MS) return;

  const steps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  profile.bankPoints = profile.bankPoints * Math.pow(DECAY_MULT, steps);
  profile.lastDecayAt += steps * DECAY_INTERVAL_MS;
  persistProfile();
}

function computeBoost(now = Date.now()) {
  if (!profile.boostReadyAt) {
    profile.boostReadyAt = now + hoursToMs(randInt(2, 6));
    persistProfile();
  }

  if (profile.boostActiveUntil && now < profile.boostActiveUntil) {
    profile.boostMult = 1.25;
    return;
  }

  if (now >= profile.boostReadyAt) {
    profile.boostActiveUntil = now + 5 * 60 * 1000;
    profile.boostReadyAt = now + hoursToMs(randInt(2, 6));
    persistProfile();
    toast("Boost active! +25% points for 5 minutes");
    profile.boostMult = 1.25;
    return;
  }

  profile.boostMult = 1.0;
}

function boostCountdownText(now = Date.now()) {
  if (profile.boostActiveUntil && now < profile.boostActiveUntil) {
    const ms = profile.boostActiveUntil - now;
    const m = Math.max(0, Math.floor(ms / 60000));
    const s = Math.max(0, Math.floor((ms % 60000) / 1000));
    return `ON ${m}m ${s}s`;
  }
  const ms = Math.max(0, profile.boostReadyAt - now);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// =====================================================
// GAME: 4-lane runner
// =====================================================
const game = {
  started: false,
  over: false,
  lane: 1,
  runScore: 0,
  t: 0,
  speed: 1.0,
  obstacles: [],
  coins: [],
  lastSpawnAt: 0,
  lastCoinAt: 0,
  lastPowerAt: 0,
  // last time a powerup actually spawned (used for "pity" so powerups don't disappear late-game)
  lastPowerSpawnedAt: 0,
  magnetUntil: 0,
  slowUntil: 0,
  shieldUntil: 0,
  dblUntil: 0,
  lastFrame: performance.now()
};

function resetRun() {
  game.started = true;
  game.over = false;
  game.lane = 1;
  game.playerX = null; // will be initialized from geometry for smooth lane transitions
  game.runScore = 0;
  game.t = 0;
  game.speed = 1.0;
  game.obstacles = [];
  game.coins = [];
  game.lastSpawnAt = 0;
  game.lastCoinAt = 0;
  game.lastPowerAt = 0;
  game.lastPowerSpawnedAt = 0;

  // Reset powerups so new runs behave consistently
  game.magnetUntil = 0;
  game.slowUntil = 0;
  game.shieldUntil = 0;
  game.dblUntil = 0;

  startBgm();
}
resetRun();

async function saveRunToBank() {
  applyDecay();
  if (game.runScore <= 0) {
    toast("No points to save");
    return;
  }
  const pts = Math.floor(game.runScore);
  // Local bank first (instant UX)
  profile.bankPoints += pts;
  game.runScore = 0;
  persistProfile();
  toast("Saved locally — confirm on-chain…", 1600);

  // Real human on-chain movement (background-friendly single tx)
  try {
    if (!account) {
      // allow local save without wallet; on-chain when connected
      toast("Saved (connect wallet to also save on-chain)");
      return;
    }
    const txHash = await sendCoreTx(CORE_FN.saveRun, [BigInt(pts)], "Confirm saveRun on Arc…");
    console.log("saveRun tx", txHash);
    toast(`On-chain save ✓ (+${pts})`, 2200);
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/reject|denied|cancel/i.test(msg)) {
      toast("Local save kept — on-chain cancelled");
    } else {
      toast("Local save kept — on-chain failed");
      console.warn("saveRun", e);
    }
  }
}

function convertCoinsToBank() {
  applyDecay();
  if (profile.coins <= 0) {
    toast("No coins to convert");
    return;
  }
  // 1 coin = 10 points
  const pts = Math.floor(profile.coins) * 10;
  profile.coins = 0;
  profile.bankPoints += pts;
  persistProfile();
  toast(`Converted +${pts} points`);
}

// =====================================================
// LEADERBOARD API
// =====================================================
async function fetchLeaderboard({ refresh = false, names = false } = {}) {
  const qs = new URLSearchParams();
  if (refresh) qs.set("refresh", "1");
  qs.set("names", names ? "1" : "0");
  if (account && /^0x[a-fA-F0-9]{40}$/.test(account)) qs.set("address", account);

  const url = `/api/leaderboard?${qs.toString()}`;
  const res = await fetch(url, { cache: "no-store" });

  const j = await res.json().catch(() => ({}));
  if (!j || j.ok !== true) {
    const msg = (j && (j.error || j.hint)) ? `${j.error || "Leaderboard error"}${j.hint ? `\n${j.hint}` : ""}` : "Leaderboard API failed";
    throw new Error(msg);
  }

  const normalize = (arr) =>
    (arr || []).map((x) => ({
      addr: x.address,
      pts: BigInt(x.points),
      name: x.name
    }));

  return {
    weekStart: j.weekStart,
    prevWeekStart: j.prevWeekStart,
    weeklySorted: normalize(j.weekly),
    prevWeekSorted: normalize(j.lastWeek),
    meta: j.meta,
    you: j.you || null
  };
}

// =====================================================
// Leaderboard deposit — ONE on-chain depositScore() tx
// =====================================================
let commitInFlight = false;

async function commitWeeklyOnchain() {
  if (commitInFlight) return;
  commitInFlight = true;

  const commitBtn = document.getElementById("btnCommit");
  const prevBtnText = commitBtn ? commitBtn.textContent : "";
  if (commitBtn) {
    commitBtn.disabled = true;
    commitBtn.textContent = "Preparing…";
  }

  try {
    applyDecay();

    if (!account) {
      await connectWallet();
      if (!account) return;
    }

    const pts = Math.floor(profile.bankPoints);
    if (pts <= 0) {
      toast("Bank is empty");
      return;
    }

    const weekStart = weekStartUtcMs();
    const addr = String(account).toLowerCase();

    // Single on-chain transaction (no personal_sign double popup)
    if (commitBtn) commitBtn.textContent = "Confirm in wallet…";
    const txHash = await sendCoreTx(
      CORE_FN.depositScore,
      [BigInt(pts), BigInt(weekStart)],
      "Confirm leaderboard deposit on Arc…"
    );

    if (commitBtn) commitBtn.textContent = "Confirming…";
    await waitTxLight(txHash);

    // Index into Neon for fast leaderboard UI
    const timestamp = Date.now();
    // lightweight auth: use a short personal_sign only if API still requires it —
    // prefer txHash proof path: send deposit with dummy sig skipped by updating API
    const res = await fetch("/api/deposit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: addr,
        points: pts,
        weekStartMs: weekStart,
        txHash,
        timestamp,
        signature: "onchain",
        onchain: true
      })
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) throw new Error(j?.error || "Index failed (tx may still be on-chain)");

    const wasLocked = !isLeaderboardUnlocked();
    addToTotalDeposited(pts);
    const nowUnlocked = isLeaderboardUnlocked();

    profile.bankPoints = 0;
    persistProfile();

    if (wasLocked && nowUnlocked) {
      toast("🏆 LEADERBOARD UNLOCKED!", 3200);
    } else {
      toast("On-chain leaderboard deposit ✓", 2200);
    }

    if (isSheetOpen()) await openLeaderboardsView();
  } catch (e) {
    const msg = String(e?.message || e || "Commit failed");
    if (/reject|denied|cancel/i.test(msg)) toast("Transaction cancelled");
    else toast(msg, 4000);
  } finally {
    commitInFlight = false;
    if (commitBtn) {
      commitBtn.disabled = false;
      commitBtn.textContent = prevBtnText || "Deposit Saved points → Weekly leaderboard ( Important )";
    }
  }
}

// =====================================================
// Controls: instant + no double triggers
// =====================================================
function bindInstantTap(btn, fn) {
  btn.style.touchAction = "none";

  const onPointerDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ensureAudioUnlocked();
    // Start warming web3 deps on the first real user gesture (doesn't block the tap).
    // This makes the Deposit button feel instant after a short play session.
    warmWeb3Deps();
    fn();
  };

  btn.addEventListener("pointerdown", onPointerDown, { passive: false });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

function moveLane(delta) {
  if (game.over) return;
  const step = isDoubleLaneOn() ? 2 : 1;
  const next = Math.max(0, Math.min(3, game.lane + delta * step));
  game.lane = next;
}

// =====================================================
// Swipe controls (mobile): smooth left/right gesture
// - Works alongside buttons (Left/Right)
// - Does NOT affect gameplay logic; only calls moveLane()
// =====================================================
function bindSwipeControls(targetEl) {
  if (!targetEl) return;

  // Ensure the browser doesn't scroll/zoom on the play area.
  targetEl.style.touchAction = "none";

  let tracking = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let fired = false;

  // Tap responsiveness:
  // We schedule a tiny "tap" action on pointerdown and cancel it if the user starts swiping.
  // This removes the perceived delay of waiting for pointerup on mobile, while keeping swipe behavior intact.
  let tapTimer = null;
  function clearTapTimer() {
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
  }
  function scheduleTap() {
    clearTapTimer();
    tapTimer = setTimeout(() => {
      if (!tracking || fired || game.over) return;
      const r = targetEl.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      fired = true;
      hapticTap();
      moveLane(startX >= mid ? +1 : -1);
    }, 70); // ~1–2 frames on mobile; feels instant but still cancelable
  }

  function swipeThresholdPx() {
    const r = targetEl.getBoundingClientRect();
    // 6–7% of width, clamped for small/large screens
    return Math.max(26, Math.min(64, r.width * 0.065));
  }

  function onDown(ev) {
    // Allow the existing “tap to restart” behavior when game is over.
    if (game.over) return;
    // Ignore right-click/mouse secondary buttons
    if (ev.pointerType === "mouse" && ev.button !== 0) return;

    ev.preventDefault();
    ev.stopPropagation();

    tracking = true;
    fired = false;
    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    startT = performance.now();

    ensureAudioUnlocked();
    // Warm deps on first gesture; doesn't block gameplay.
    warmWeb3Deps();

    scheduleTap();

    try {
      targetEl.setPointerCapture(pointerId);
    } catch {
      // Some environments may not support capture; safe to ignore.
    }
  }

  function onMove(ev) {
    if (!tracking || pointerId !== ev.pointerId) return;
    if (game.over) return;

    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    // If the finger starts moving, it's probably not a pure tap — cancel scheduled tap quickly.
    if (ax > 8 || ay > 8) clearTapTimer();

    // Already fired via early-tap or a previous swipe
    if (fired) return;

    // Must be mostly horizontal.
    if (ax < swipeThresholdPx()) return;
    if (ax < ay * 1.25) return;

    ev.preventDefault();
    ev.stopPropagation();

    clearTapTimer();
    fired = true;
    hapticTap();
    moveLane(dx > 0 ? +1 : -1);
  }

  function onUp(ev) {
    if (pointerId !== ev.pointerId) return;

    // Avoid generating a delayed "click" on some mobile browsers
    ev.preventDefault();
    ev.stopPropagation();

    const dt = performance.now() - startT;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    // If user released before the scheduled tap fired, treat it as an immediate tap.
    if (!game.over && !fired && dt < 260 && ax < 10 && ay < 10) {
      const r = targetEl.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      fired = true;
      hapticTap();
      moveLane(ev.clientX >= mid ? +1 : -1);
    }

    clearTapTimer();
    tracking = false;
    pointerId = null;
    fired = false;
  }

  function onCancel(ev) {
    if (pointerId !== ev.pointerId) return;
    clearTapTimer();
    tracking = false;
    pointerId = null;
    fired = false;
  }

  targetEl.addEventListener("pointerdown", onDown, { passive: false });
  targetEl.addEventListener("pointermove", onMove, { passive: false });
  targetEl.addEventListener("pointerup", onUp, { passive: false });
  targetEl.addEventListener("pointercancel", onCancel, { passive: true });
}


bindInstantTap(els.leftBtn, () => {
  hapticTap();
  moveLane(-1);
});
bindInstantTap(els.rightBtn, () => {
  hapticTap();
  moveLane(+1);
});
bindInstantTap(els.saveBtn, () => saveRunToBank());

// Enable swipe/tap controls on the playfield
bindSwipeControls(els.c);

// =====================================================
// Menu sheet
// =====================================================
function isSheetOpen() {
  return els.sheet.classList.contains("open");
}

function openSheet(title, bodyHtml, viewKey = "") {
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = bodyHtml;
  // Used for view-specific styling (e.g., leaderboards scroll behavior)
  if (viewKey) els.sheet.dataset.view = viewKey;
  else delete els.sheet.dataset.view;
  els.sheet.classList.add("open");
  els.sheet.setAttribute("aria-hidden", "false");
}

function closeSheet() {
  els.sheet.classList.remove("open");
  els.sheet.setAttribute("aria-hidden", "true");
  stopWeekCountdown();
}

els.menuBtn.addEventListener("click", async () => {
  applyDecay();
  computeBoost();
  renderHud();
  await openMainMenu();
});
els.closeSheet.addEventListener("click", closeSheet);
els.sheet.addEventListener("click", (e) => {
  if (e.target === els.sheet) closeSheet();
});
els.statusBadge.addEventListener("click", async () => {
  await openWalletConnectFlow();
});

async function openMainMenu() {
  // User is about to interact with wallet/deposit; warm deps aggressively but non-blocking.
  warmWeb3Deps();
  try { await refreshServerBalance(); } catch {}
  const walletLine = account ? shortAddr(account) : "Not connected";
  const week = weekIdUtc();
  const convertible = (Math.floor(profile.bankPoints) / POINTS_PER_USDC).toFixed(3);

  openSheet(
    "Menu",
    `
    <div class="menuGrid">
      <div class="kv"><div class="k">Wallet</div><div class="v">${walletLine}</div></div>
      <div class="kv"><div class="k">Network</div><div class="v">Arc Testnet</div></div>
      <div class="kv"><div class="k">Week</div><div class="v">${week} (UTC) <span class="weekCountdownWrap">(<canvas id="weekCountdownSeg" class="segCanvas" aria-label="Week remaining"></canvas>)</span></div></div>
      <div class="kv"><div class="k">Run points</div><div class="v">${Math.floor(game.runScore)}</div></div>
      <div class="kv"><div class="k">Saved points</div><div class="v">${Math.floor(profile.bankPoints)}</div></div>
      <div class="kv"><div class="k">Permanent USDC</div><div class="v">${serverUsdcBalance}</div></div>
      <div class="kv"><div class="k">Coins</div><div class="v">${Math.floor(profile.coins)} (1 coin = 10 pts → ${Math.floor(profile.coins) * 10})</div></div>
      <div class="kv"><div class="k">⚠️Saved points deduction</div><div class="v">-25% every 10 min</div></div>
      <div class="kv"><div class="k">Rate</div><div class="v">1000 pts = 1 USDC · min wd 0.1 USDC</div></div>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnConnect">${account ? "Reconnect" : "Connect wallet"}</button>
      <button class="pill" id="btnLeaderboards">Leaderboards</button>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnConvert">Convert coins</button>
      <button class="pill pillHow" id="btnHow">
        <img class="pillIcon" src="/assets/bag.png" alt="" aria-hidden="true" />
        Earn
      </button>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnToUsdc">Convert points → USDC (~${convertible})</button>
      <button class="pill primary" id="btnWithdrawUsdc">Withdraw USDC</button>
    </div>

    <div class="commitWrap">
      <button class="pill primary" id="btnCommit">Deposit Saved points → Weekly leaderboard ( Important )</button>
    </div>

    <div class="lbAccessCard ${isLeaderboardUnlocked() ? 'unlocked' : 'locked'}">
      <div class="lbAccessHead">
        <span class="lbAccessIcon">${isLeaderboardUnlocked() ? '🏆' : '🔒'}</span>
        <span class="lbAccessTitle">Leaderboard Access</span>
        <span class="lbAccessStatus">${isLeaderboardUnlocked() ? 'UNLOCKED' : 'LOCKED'}</span>
      </div>
      <div class="lbAccessBar"><div class="lbAccessFill" style="width:${getLbProgressPct()}%"></div></div>
      <div class="lbAccessInfo">
        <span><b>${getTotalDeposited().toLocaleString()}</b> / ${LEADERBOARD_UNLOCK_THRESHOLD.toLocaleString()} pts deposited</span>
        ${isLeaderboardUnlocked()
          ? '<span class="lbAccessNote good">✓ Full access</span>'
          : `<span class="lbAccessNote">${getLbRemaining().toLocaleString()} more pts to unlock</span>`
        }
      </div>
    </div>

    <div class="alertRed">
  ⚠️ Important: Deposit or convert Saved points within 10 min — otherwise 25% is deducted every 10 minutes!
</div>

    <div class="themeSwitchCard">
      <div class="themeSwitchHead">
        <span class="themeSwitchIcon">🎨</span>
        <span class="themeSwitchTitle">Theme</span>
      </div>
      <div class="themeSwitchOpts">
        <button class="themeOpt" data-theme="light" id="themeLight">
          <span class="themeOptIcon">☀️</span>
          <span class="themeOptLbl">Light</span>
        </button>
        <button class="themeOpt" data-theme="dark" id="themeDark">
          <span class="themeOptIcon">🌙</span>
          <span class="themeOptLbl">Dark</span>
        </button>
      </div>
    </div>
  `,


    "menu"
  );

  startWeekCountdown();

  $("#btnConnect").addEventListener("click", async () => {
    await openWalletConnectFlow();
  });

  $("#btnLeaderboards").addEventListener("click", openLeaderboardsView);
  $("#btnConvert").addEventListener("click", () => {
    convertCoinsToBank();
    openMainMenu();
  });
  $("#btnToUsdc")?.addEventListener("click", () => convertPointsToUsdc());
  $("#btnWithdrawUsdc")?.addEventListener("click", () => openWithdrawUsdcView());
  $("#btnHow").addEventListener("click", openHowView);

  const commitBtn = $("#btnCommit");
  // Single click handler only (pointerdown+click was double-firing wallet popups)
  commitBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (commitInFlight) return;
    commitWeeklyOnchain();
  });

  // Theme switcher wiring
  try {
    const current = getTheme();
    const btnL = $("#themeLight");
    const btnD = $("#themeDark");
    if (btnL && btnD) {
      if (current === "light") btnL.classList.add("active");
      else btnD.classList.add("active");
      btnL.addEventListener("click", () => { setTheme("light"); btnL.classList.add("active"); btnD.classList.remove("active"); });
      btnD.addEventListener("click", () => { setTheme("dark");  btnD.classList.add("active"); btnL.classList.remove("active"); });
    }
  } catch {}
}


function openHowView() {
  openSheet(
    "Earn & Know how it works",
    `
    <div class="copy">
      <p>>Soon weekly earning function will be live...</p>
      <p>But for that I need users. This is not possible without sufficient ranking. Please play it yourself and share it with your friends.❤️</p>
      <p>BTW, </p>
      
      <p><b>Play short runs.</b> Your <b>Run</b> points grow while you survive.</p>
      <p><b>Save</b> moves Run → <b>Bank</b> instantly (no transaction).</p>
      <p><b>Bank decays</b>: every <b>15 minutes</b>, Bank is reduced by <b>25%</b>.</p>
      <p><b>Coins</b>: 1 coin = <b>10 points</b>. Convert from the Menu.</p>
      <p><b>Commit</b> is optional and on-chain. It adds your current Bank to your <b>Weekly public leaderboard</b>.</p>
    </div>
    <div class="btnRow">
      <button class="pill" id="backMenu">Back</button>
      <button class="pill" id="goBoards">Leaderboards</button>
    </div>
  `,
    "how"
  );
  $("#backMenu").addEventListener("click", openMainMenu);
  $("#goBoards").addEventListener("click", openLeaderboardsView);
}

let boardsInFlight = false;

function topN(list, n) {
  return list.slice(0, n);
}

// ---- Share helpers (Leaderboards -> "Share your stat") ----
let lastWeeklyShareCtx = null;
// ---- Share rewards (local, anti-cheat via composeCast result) ----
const SHARE_MAX = 10;
const SHARE_REWARD_POINTS = 10000;
const LS_SHARE_COUNT = "gasrun_share_count";
// Daily reset window (UTC day) for SHARE_MAX.
// NOTE: We use UTC to match leaderboard timestamps (also shown as UTC in the UI).
const LS_SHARE_DAY_UTC = "gasrun_share_day_utc";
const LS_LAST_REWARDED_CAST = "gasrun_last_rewarded_cast";

const SHARE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const LS_SHARE_COOLDOWN_PREFIX = "gasrun_share_cooldown_until_";

function getShareCount() {
  ensureDailyShareReset();
  return Math.max(0, Number(localStorage.getItem(LS_SHARE_COUNT) || "0") | 0);
}
function setShareCount(n) {
  ensureDailyShareReset();
  const v = Math.max(0, Math.min(SHARE_MAX, n | 0));
  localStorage.setItem(LS_SHARE_COUNT, String(v));
  updateShareUI();
  return v;
}

function _utcDayKey(ts = Date.now()) {
  // YYYY-MM-DD in UTC
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Enforce daily share window.
 * Resets share count when the UTC day changes.
 */
function ensureDailyShareReset() {
  try {
    const today = _utcDayKey();
    const stored = localStorage.getItem(LS_SHARE_DAY_UTC) || "";
    if (stored !== today) {
      localStorage.setItem(LS_SHARE_DAY_UTC, today);
      localStorage.setItem(LS_SHARE_COUNT, "0");
    }
  } catch (_) {
    // Ignore storage errors; sharing will just behave like before.
  }
}
function _shareCooldownKey(acct) {
  const a = String(acct || "").toLowerCase();
  return LS_SHARE_COOLDOWN_PREFIX + a;
}
function getShareCooldownUntil(acct) {
  return Math.max(0, Number(localStorage.getItem(_shareCooldownKey(acct)) || "0") || 0);
}
function setShareCooldownUntil(acct, ts) {
  if (!acct) return 0;
  const v = Math.max(0, Math.floor(Number(ts) || 0));
  localStorage.setItem(_shareCooldownKey(acct), String(v));
  updateShareUI();
  return v;
}
function _fmtMmSs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

let _shareCooldownTimer = null;
function startShareCooldownTicker() {
  if (_shareCooldownTimer) return;
  _shareCooldownTimer = setInterval(() => {
    // Stop ticking when the Leaderboards share UI is not on screen
    if (!document.getElementById("shareStat") && !document.getElementById("shareCooldown")) {
      clearInterval(_shareCooldownTimer);
      _shareCooldownTimer = null;
      return;
    }
    updateShareUI();
  }, 1000);
}
function startShareCooldown(acct) {
  if (!acct) return;
  setShareCooldownUntil(acct, Date.now() + SHARE_COOLDOWN_MS);
  startShareCooldownTicker();
}

function updateShareUI() {
  const used = getShareCount();
  const usedEl = $("#shareUsed");
  const maxEl = $("#shareMax");
  if (usedEl) usedEl.textContent = String(used);
  if (maxEl) maxEl.textContent = String(SHARE_MAX);

  const acct = account || "";
  const until = getShareCooldownUntil(acct);
  const remaining = until - Date.now();
  const onCooldown = remaining > 0;

  const cdEl = $("#shareCooldown");
  if (cdEl) cdEl.textContent = onCooldown ? _fmtMmSs(remaining) : "";

  const btn = $("#shareStat");
  if (btn) {
    const disabled = used >= SHARE_MAX || onCooldown;
    btn.disabled = disabled;
    btn.classList.toggle("disabled", disabled);
  }
}

function _getBoardsNoticeEl() {
  return document.getElementById("boardsNotice") || null;
}
let _boardsNoticeTimer = null;

/** Show a temporary info message inside the Leaderboards header area (no toast). */
function showShareInfoBanner(msg) {
  const el = _getBoardsNoticeEl();
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("reward");
  el.classList.add("show");
  clearTimeout(_boardsNoticeTimer);
  _boardsNoticeTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2400);
}

/** Show the "+10,000 Saved points" animation inside the Leaderboards header area (no toast). */
function showShareRewardBanner(points, durationMs = 2600) {
  const el = _getBoardsNoticeEl();
  if (!el) return;
  el.innerHTML =
    `<span class="rewardPlus">+${fmtPts(points)}</span> ` +
    `<span class="rewardTxt">Saved points added — deposit to leaderboard 💚</span>`;
  el.classList.add("reward");
  el.classList.add("show");
  clearTimeout(_boardsNoticeTimer);
  _boardsNoticeTimer = setTimeout(() => {
    el.classList.remove("show");
  }, durationMs);
}

function awardShareBonusIfNewCast(cast) {
  const castId = (cast && (cast.hash || cast.id)) ? String(cast.hash || cast.id) : "";
  if (castId) {
    const last = localStorage.getItem(LS_LAST_REWARDED_CAST) || "";
    if (last === castId) return false; // already rewarded
    localStorage.setItem(LS_LAST_REWARDED_CAST, castId);
  }

  // add immediately to Saved points (bank)
  profile.bankPoints = Math.floor(profile.bankPoints) + SHARE_REWARD_POINTS;
  persistProfile();
  renderHud();

  // increment successful share count
  setShareCount(getShareCount() + 1);

  showShareRewardBanner(SHARE_REWARD_POINTS);
  startShareCooldown(account);
  return true;
}

// Base App fallback: some clients don't return a cast identifier from composeCast.
// User requested an easy rule: after clicking Share, reward after 5s.
function awardShareBonusFallback() {
  if (getShareCount() >= SHARE_MAX) {
    updateShareUI();
    return false;
  }
  profile.bankPoints = Math.floor(profile.bankPoints) + SHARE_REWARD_POINTS;
  persistProfile();
  renderHud();
  setShareCount(getShareCount() + 1);
  // Show the reward banner longer (10s) as requested.
  showShareRewardBanner(SHARE_REWARD_POINTS, 10000);
  startShareCooldown(account);
  return true;
}

let _shareInFlight = false;


function _buildShareUrl(ctx) {
  const p = new URLSearchParams();
  if (ctx.weekLabel) p.set("week", ctx.weekLabel);
  if (ctx.rank != null) p.set("rank", String(ctx.rank));
  if (ctx.pts != null) p.set("pts", String(ctx.pts));
  if (ctx.account) p.set("addr", ctx.account);
  // The embed URL is what Farcaster/Base will scrape + attach to the cast.
  return `${HOME_URL}api/share?${p.toString()}`;
}

function _buildShareText(ctx) {
  const rank = ctx.rank != null ? `#${ctx.rank}` : "—";
  const pts = ctx.pts != null ? fmtPts(ctx.pts) : "0";
  const who = ctx.account ? shortAddr(ctx.account) : "my run";
  // Keep it readable + "post-ready" (user can edit if they want).
  return [
    `🏁 GasRun Weekly Stats`,
    `Rank: ${rank}`,
    `Points: ${pts}`,
    `Wallet: ${who}`,
    ``,
    `Can you beat me? 🏃‍♂️💨`
  ].join("\n");
}

async function shareCurrentWeeklyStat() {
  if (_shareInFlight) return;

  // 1h cooldown after each successful share
  const acct = account || "";
  const until = getShareCooldownUntil(acct);
  if (until > Date.now()) {
    showShareInfoBanner(`Next share in ${_fmtMmSs(until - Date.now())}`);
    updateShareUI();
    startShareCooldownTicker();
    return;
  }

  const used = getShareCount();
  if (used >= SHARE_MAX) {
    showShareInfoBanner("Share limit reached (10/10).");
    updateShareUI();
    return;
  }

  if (!account) {
    showShareInfoBanner("Connect wallet to share your stat.");
    return;
  }
  if (!lastWeeklyShareCtx || lastWeeklyShareCtx.rank == null) {
    showShareInfoBanner("No weekly points yet—commit Bank points first.");
    return;
  }

  const shareUrl = _buildShareUrl(lastWeeklyShareCtx);
  const text = _buildShareText(lastWeeklyShareCtx);

  // Environment hint:
  // - Base App / MiniKit hosts expose window.miniapp.sdk
  // - Farcaster (e.g., Warpcast) hosts expose window.frame.sdk
  // We only use the timer-based reward fallback for Base.
  const isBaseHost = !!(window.miniapp && window.miniapp.sdk);
  const isFarcasterHost = !!(window.frame && window.frame.sdk);
  const useBaseTimerFallback = isBaseHost && !isFarcasterHost;

  // Try native compose (Base App / Farcaster clients)
  try {
    const s = await ensureSdk(4000);
    if (s && s.actions && typeof s.actions.composeCast === "function") {
      _shareInFlight = true;
      const btn = $("#shareStat");
      if (btn) btn.disabled = true;

      // Base-only fallback reward timer: some Base clients don't return a cast id/hash.
      // IMPORTANT: Do NOT run this fallback in Farcaster, otherwise users could cancel
      // and still receive rewards.
      let fallbackFired = false;
      let fallbackTimer = null;
      if (useBaseTimerFallback) {
        fallbackTimer = setTimeout(() => {
          if (fallbackFired) return;
          fallbackFired = true;
          awardShareBonusFallback();
        }, 5000);
      }

      // NOTE: Farcaster Mini Apps SDK returns { cast: Cast|null } (or undefined if close=true).
      const res = await s.actions.composeCast({
        text,
        embeds: [shareUrl]
      });

      _shareInFlight = false;
      updateShareUI();

      const cast = res && (res.cast || res);
      if (cast && (cast.hash || cast.id)) {
        fallbackFired = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        awardShareBonusIfNewCast(cast);
        return;
      }

      // Cancel only when the client explicitly returns `cast: null` (user closed/cancelled).
      // Some clients (Base) may return a `cast` object without an id/hash even on success.
      if (res && Object.prototype.hasOwnProperty.call(res, "cast") && res.cast == null) {
        fallbackFired = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        showShareInfoBanner("Share cancelled.");
        return;
      }

      // Base: keep the easy rule (reward after 5s).
      if (useBaseTimerFallback) {
        showShareInfoBanner("Sharing… bonus adds in 5s.");
        return;
      }

      // Farcaster: if we didn't get a cast id/hash, treat it as cancelled (no reward).
      showShareInfoBanner("Share cancelled.");
      return;
    }
  } catch (_) {
    _shareInFlight = false;
    updateShareUI();
    // fall through
  }

  // Browser fallback (cannot reliably confirm Post -> no reward)
  showShareInfoBanner("Tip: Share from Base App/Farcaster to earn +10k bonus.");
  const intent =
    `https://warpcast.com/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(shareUrl)}`;
  window.open(intent, "_blank", "noopener,noreferrer");
}


async function openLeaderboardsView(forceRefresh = false) {
  if (boardsInFlight) return;
  boardsInFlight = true;

  openSheet(
    "Leaderboards",
    `
    <div class="boardsNotice" id="boardsNotice" aria-live="polite"></div>
    <div class="btnRow" style="margin-top:12px">
      <button class="pill" id="backMenu">Back</button>
      <div class="shareBlock">
  <button class="pill sharePill" id="shareStat">Share for 10k points/per</button>
  <div class="shareMeta" id="shareMeta">
    Shared <span class="shareUsed" id="shareUsed">0</span> / <span class="shareMax" id="shareMax">10</span>
  </div>
  <div class="shareCooldown" id="shareCooldown"></div>
</div>
      <button class="pill" id="refreshBoards">Refresh</button>
    </div>
    <div id="boards" class="boardsWrap"></div>
  `,
    "boards"
  );

  $("#backMenu").addEventListener("click", openMainMenu);
  $("#refreshBoards").addEventListener("click", () => openLeaderboardsView(true));
  $("#shareStat").addEventListener("click", shareCurrentWeeklyStat);
  updateShareUI();
  startShareCooldownTicker();

  try {
    const data = await fetchLeaderboard({ refresh: forceRefresh, names: false });
    const { weekStart, prevWeekStart, weeklySorted, prevWeekSorted, you } = data;

    const weekLabel = new Date(weekStart).toISOString().slice(0, 10);
    const lastWeekLabel = new Date(prevWeekStart).toISOString().slice(0, 10);

    const weeklyTop = topN(weeklySorted, 100);
        // Show previous week's leaderboard too (scrollable like the other sections)
    const lastWinners = topN(prevWeekSorted, 100);

const weeklyIndex = account
  ? weeklySorted.findIndex((x) => x.addr.toLowerCase() === account.toLowerCase())
  : -1;

// Rank/points can come from the API (works even when you're outside top 100).
const apiWeeklyRank =
  you && you.weekly && typeof you.weekly.rank === "number" ? you.weekly.rank : null;
const apiWeeklyPts =
  you && you.weekly && typeof you.weekly.points === "string" ? BigInt(you.weekly.points) : null;

const yourWeeklyRank = apiWeeklyRank != null ? apiWeeklyRank : weeklyIndex >= 0 ? weeklyIndex + 1 : null;
const yourWeeklyPts = apiWeeklyPts != null ? apiWeeklyPts : weeklyIndex >= 0 ? weeklySorted[weeklyIndex].pts : 0n;
    lastWeeklyShareCtx = { weekLabel, weekStart, rank: yourWeeklyRank, pts: yourWeeklyPts, account };

    const paletteForIndex = (i) => {
      // Golden-angle sequence spreads hues nicely even for 100 entries.
      const hue = (i * 137.508) % 360;
      const sat = 58;
      // Keep colors pleasant: not too deep, not too light.
      // - text: readable on dark background
      // - row*: subtle full-row tint for "Last week" section
      const h = hue.toFixed(1);
      return {
        text: `hsl(${h}, ${sat}%, 45%)`,
        // kept for backwards-compat (address pill mode)
        bg: `hsl(${h}, ${sat}%, 83%)`,

        rowBg: `hsla(${h}, ${sat}%, 18%, 0.70)`,
        rowBg2: `hsla(${h}, ${sat}%, 24%, 0.26)`,
        rowBorder: `hsla(${h}, ${sat}%, 55%, 0.28)`,
        rowGlow: `hsla(${h}, ${sat}%, 55%, 0.18)`
      };
    };

    const renderList = async (items, opts = {}) => {
      const showFullAddr = !!opts.showFullAddr;
      const colorMode = opts.colorMode || null; // "text" | "bg" | "row" | null

      const rows = await Promise.all(
        items.map(async (x, i) => {
          const nameRaw = (typeof x.name === "string" && x.name && !String(x.name).includes("[object Object]")) ? x.name : await displayNameFor(x.addr);
          const nameStr = String(nameRaw || "");
          const isFullAddr = /^0x[a-fA-F0-9]{40}$/.test(nameStr);

          // Default: keep rows compact (shorten full addresses). For "Last week",
          // show the full address as requested.
          const display = isFullAddr ? (showFullAddr ? nameStr : shortAddr(nameStr)) : nameStr;

          // Only add tooltip when we're shortening the address.
          const titleAttr = isFullAddr && !showFullAddr ? ` title="${nameStr}"` : "";

          // Color palette: up to 100 entries get 100 distinct colors (per list).
          const c = paletteForIndex(i);
          const styleAttr =
            colorMode === "text"
              ? ` style="--addrColor:${c.text};"`
              : colorMode === "bg"
                ? ` style="--addrBg:${c.bg};"`
                : "";

          const entryStyleAttr =
            colorMode === "row"
              ? ` style="--rowBg:${c.rowBg};--rowBg2:${c.rowBg2};--rowBorder:${c.rowBorder};--rowGlow:${c.rowGlow};"`
              : "";

          const addrClasses = [
            "addr",
            isFullAddr ? "addrFull" : "",
            colorMode === "text" ? "addrColor" : "",
            colorMode === "bg" ? "addrBg" : "",
            isFullAddr && showFullAddr ? "addrBreak" : ""
          ].filter(Boolean).join(" ");

          return `
            <div class="entry${colorMode === "row" ? " entryRow" : ""}"${entryStyleAttr}>
              <div class="left">
                <div class="rankBadge">#${i + 1}</div>
                <div class="${addrClasses}"${titleAttr}${styleAttr}>${display}</div>
              </div>
              <div class="points">${fmtPts(x.pts)}</div>
            </div>
          `;
        })
      );
      return rows.join("");
    };

    const weeklyHtml = await renderList(weeklyTop, { colorMode: "text" });
        const winnersHtml =
      lastWinners.length === 0
        ? `<div class="copy">No winners data found for last week.</div>`
        : `<div class="boardList">${await renderList(lastWinners, { showFullAddr: true, colorMode: "row" })}</div>`;

    $("#boards").innerHTML = `
      <div class="board">
        <div class="boardTitle"><div>Weekly (since ${weekLabel} UTC) <span class="weekCountdownWrap">(<canvas id="weekCountdownBoardsSeg" class="segCanvas" aria-label="Week remaining"></canvas>)</span></div><div>Top 100</div></div>
        <div class="boardList">${weeklyHtml || `<div class="copy">No entries yet.</div>`}</div>
        <div class="subcopy">
          ${
            account
              ? yourWeeklyRank
                ? yourWeeklyRank <= 100
                  ? `You: #${yourWeeklyRank} (${fmtPts(yourWeeklyPts)})`
                  : `You: #${yourWeeklyRank} (${fmtPts(yourWeeklyPts)}) — outside top 100`
                : `No on-chain points found for your address this week yet.`
              : "Connect wallet to see your rank."
          }
        </div>
      </div>

      <div class="board winners">
        <div class="boardTitle"><div>Last week (since ${lastWeekLabel} UTC)</div><div>Top 100</div></div>
        ${winnersHtml}
      </div>
    `;

    startWeekCountdown();
  } catch (e) {
    $("#boards").innerHTML = `<div class="copy">Could not load on-chain logs. Try Refresh. ${
      e?.message ? `<br/><span class="mono">${String(e.message)}</span>` : ""
    }</div>`;
  } finally {
    boardsInFlight = false;
  }
}

// =====================================================
// Canvas sizing
// =====================================================
const ctx = els.c.getContext("2d");

function resize() {
  const wrap = els.c.parentElement;
  const w = Math.floor(wrap.clientWidth);
  const h = Math.floor(wrap.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  els.c.width = Math.floor(w * dpr);
  els.c.height = Math.floor(h * dpr);
  els.c.style.width = `${w}px`;
  els.c.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// =====================================================
// Render + update
// =====================================================
function renderHud() {
  els.runScore.textContent = String(Math.floor(game.runScore));
  els.coins.textContent = String(Math.floor(profile.coins));
  els.bankPoints.textContent = String(Math.floor(profile.bankPoints));
  els.boost.textContent = boostCountdownText() + powerupCountdownText(game.t);
}

function laneGeometry() {
  const wrap = els.c;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  // Road is intentionally wide (fills screen), but "drive lanes" are kept within a slightly narrower inner region
  // so:
  // 1) outer-lane cars don't ride on the edge lines / rounded corners
  // 2) lane-to-lane distance doesn't feel too big on large screens
  const roadW = Math.min(440, w * 0.88);
  const roadH = h * 0.92;
  const roadX = (w - roadW) / 2;
  const roadY = (h - roadH) / 2 + 2;

  const cornerR = 26;

  const lanes = 4;

  // Clamp lane width on large canvases so lane switching feels natural.
  const laneWRaw = roadW / lanes;
  const laneW = Math.min(92, laneWRaw);

  // Inner drive region (centered), creating "shoulders" near the edges.
  const lanesW = laneW * lanes;
  const lanesX = roadX + (roadW - lanesW) / 2;

  // Spawn/movement safe vertical area (avoid rounded corners at top/bottom)
  const safeTop = roadY + cornerR + 6;
  const safeBottom = roadY + roadH - cornerR - 6;

  return { w, h, roadX, roadY, roadW, roadH, lanes, laneW, lanesX, lanesW, cornerR, safeTop, safeBottom };
}

function laneCenterX(g, laneIndex) {
  return g.lanesX + g.laneW * (laneIndex + 0.5);
}

function spawnObstacle() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const size = Math.max(36, Math.min(56, g.laneW * 0.55));
  const w = Math.max(28, size * 0.82);
  const h = Math.max(40, size * 1.18);

  const ENEMY_COLORS = [
    "rgba(255,80,120,0.95)",
    "rgba(255,188,64,0.95)",
    "rgba(160,110,255,0.95)",
    "rgba(60,220,160,0.95)",
    "rgba(90,190,255,0.95)"
  ];
  const color = ENEMY_COLORS[randInt(0, ENEMY_COLORS.length - 1)];

  game.obstacles.push({ lane, y: g.safeTop - h - 8, size, w, h, color });
}

function spawnCoin() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const x = laneCenterX(g, lane);

  // Normal coin (+1) + bonus coins (5x/10x/100x)
  const r = 10;
  let kind = "coin";
  let value = 1;

  const roll = Math.random();
  // 8% => 5x, 1.5% => 10x, 0.5% => 100x
  if (roll < 0.08) {
    kind = "bonus";
    value = 5;
  } else if (roll < 0.095) {
    kind = "bonus";
    value = 10;
  } else if (roll < 0.10) {
    kind = "bonus";
    value = 100;
  }

  game.coins.push({ lane, x, y: g.safeTop - 24, r, kind, value });
}

function spawnPowerUp() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const x = laneCenterX(g, lane);
  const y = g.safeTop - 28;

  // Weighted random selection
  const roll = Math.random();
  // 40% magnet, 35% slow, 15% shield, 10% double-lane
  let kind = "magnet";
  if (roll < 0.40) kind = "magnet";
  else if (roll < 0.75) kind = "slow";
  else if (roll < 0.90) kind = "shield";
  else kind = "dbl";

  game.coins.push({ lane, x, y, r: 12, kind, value: 0 });
}

// NOTE: Game powerups use simulation time (game.t) in **seconds**.
// Keeping everything on the same timebase prevents "phantom shield" / wrong countdowns.
function isMagnetOn(now = game.t) {
  return !!game.magnetUntil && now < game.magnetUntil;
}
function isSlowOn(now = game.t) {
  return !!game.slowUntil && now < game.slowUntil;
}
function isShieldOn(now = game.t) {
  return !!game.shieldUntil && now < game.shieldUntil;
}
function isDoubleLaneOn(now = game.t) {
  return !!game.dblUntil && now < game.dblUntil;
}

// Safety: if any timer is accidentally set with the wrong unit (ms vs sec),
// clamp it so it can't become "permanent" until refresh.
function sanitizePowerups(now = game.t) {
  const clamp = (val, maxSec) => {
    if (!val || !isFinite(val)) return 0;
    // already expired
    if (val <= now) return 0;
    // wrong unit or corrupted (too far in the future)
    if (val - now > maxSec + 1) return now + maxSec;
    return val;
  };

  game.magnetUntil = clamp(game.magnetUntil, 7);
  game.slowUntil = clamp(game.slowUntil, 6.5);
  game.shieldUntil = clamp(game.shieldUntil, 20);
  game.dblUntil = clamp(game.dblUntil, 9);
}

function powerupCountdownText(now = game.t) {
  const parts = [];
  const sec = (s) => Math.max(0, Math.ceil(s));
  if (isMagnetOn(now)) parts.push(`Mag ${sec(game.magnetUntil - now)}s`);
  if (isSlowOn(now)) parts.push(`Slow ${sec(game.slowUntil - now)}s`);
  if (isShieldOn(now)) parts.push(`Shield ${sec(game.shieldUntil - now)}s`);
  if (isDoubleLaneOn(now)) parts.push(`Jump2 ${sec(game.dblUntil - now)}s`);
  return parts.length ? " | " + parts.join(" | ") : "";
}


function rectsOverlap(a, b) {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

function update(dt) {
  applyDecay();
  computeBoost();

  if (game.over) return;

  game.t += dt;
  game.speed = Math.min(3.2, game.speed + dt * 0.03);

  game.runScore += dt * (8 + game.speed * 5) * profile.boostMult;

  // Use simulation time (game.t) for all timers so behavior is stable on low-end devices.
  const now = game.t;
  sanitizePowerups(now);

  // Obstacles: catch up on slow frames (cap spawns per tick to avoid "spawn floods")
  const spawnInterval = Math.max(0.28, (650 - game.speed * 80) / 1000);
  if (now - game.lastSpawnAt > spawnInterval) {
    let guard = 0;
    while (now - game.lastSpawnAt > spawnInterval && guard++ < 3) {
      game.lastSpawnAt += spawnInterval;
      spawnObstacle();
    }
  }

  // Coins: get a little more frequent as speed increases so long runs still feel rewarding
  const coinInterval = Math.max(0.70, (1200 - game.speed * 140) / 1000);
  if (now - game.lastCoinAt > coinInterval) {
    let guard = 0;
    while (now - game.lastCoinAt > coinInterval && guard++ < 3) {
      game.lastCoinAt += coinInterval;
      // keep some RNG so it doesn't become a wall of coins
      if (Math.random() < 0.82) spawnCoin();
    }
  }

  // Powerups spawn a bit slower & rarer than normal coins
  // + "pity" timer: if you survive a long time and RNG is unlucky, we still force a powerup occasionally.
  const powerInterval = Math.max(2.30, (3500 - game.speed * 220) / 1000); // gets slightly faster later
  if (now - game.lastPowerAt > powerInterval) {
    game.lastPowerAt = now;

    const sinceSpawn = now - (game.lastPowerSpawnedAt || 0);
    const force = sinceSpawn > 9.0; // guarantee at least 1 powerup every ~9s
    const chance = 0.33; // baseline

    if (force || Math.random() < chance) {
      spawnPowerUp();
      game.lastPowerSpawnedAt = now;
    }
  }

  const g = laneGeometry();

  // Smooth lane transitions:
  // - Input switches game.lane immediately (responsive)
  // - Rendering/collision use game.playerX that eases toward the lane center (smooth)
  const targetX = laneCenterX(g, game.lane);
  if (game.playerX == null || !isFinite(game.playerX)) game.playerX = targetX;

  // Time constant controls "snappiness": smaller = faster, larger = smoother.
  const tau = 0.06; // seconds (faster lane change, still smooth)
  const alpha = 1 - Math.exp(-dt / tau);
  game.playerX += (targetX - game.playerX) * alpha;

  if (Math.abs(targetX - game.playerX) < 0.25) game.playerX = targetX;

  // collision rect for the player (consistent with drawn car)
  const carW = Math.max(36, Math.min(60, g.laneW * 0.62));
  const carH = carW * 1.30;
  const carX = (game.playerX ?? laneCenterX(g, game.lane)) - carW / 2;
  const carY = g.safeBottom - carH - 14;
  const carRect = { x: carX, y: carY, w: carW, h: carH };

  const obsSpeed = (220 + game.speed * 90) * (isSlowOn(now) ? 0.55 : 1.0) * dt;
  for (const o of game.obstacles) o.y += obsSpeed;

  const coinSpeed = (190 + game.speed * 70) * dt;
  const carCx = carRect.x + carRect.w / 2;
  const carCy = carRect.y + carRect.h / 2;

  for (const c of game.coins) {
    // Base down movement for everything collectible
    c.y += coinSpeed;

    // Magnet only pulls coins/bonus coins (not powerups)
    if (isMagnetOn(now) && (c.kind === "coin" || c.kind === "bonus")) {
      const dx = carCx - (c.x ?? laneCenterX(g, c.lane));
      const dy = carCy - c.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const pull = 520 * dt; // px per second scaled by dt
      const step = Math.min(pull, dist);
      const ux = dx / dist;
      const uy = dy / dist;
      c.x = (c.x ?? laneCenterX(g, c.lane)) + ux * step;
      c.y = c.y + uy * step * 0.65;
    }
  }

  // ✅ collisions (shield-aware)
  // If shield is active: you DON'T die on crash; we just "bounce" the obstacle away.
  const shieldActive = isShieldOn(now);
  const keptObstacles = [];
  for (const o of game.obstacles) {
    const ow = o.w ?? o.size;
    const oh = o.h ?? o.size;
    const ox = laneCenterX(g, o.lane) - ow / 2;
    const oy = o.y;
    const r = { x: ox, y: oy, w: ow, h: oh };

    if (rectsOverlap(carRect, r)) {
      if (shieldActive) {
        // shield eats the collision (no game over)
        vibrate([18, 40, 18]);
        toast("🛡 Shield blocked a crash!", 650);
        // don't keep this obstacle to avoid repeated overlap in next frames
        continue;
      }

      crashVibe();
      game.over = true;
      stopBgm();
      toast("Crash! Save or restart", 2200);
      break;
    }

    keptObstacles.push(o);
  }

  // If we didn't die, update obstacle list (removes ones that hit shield)
  if (!game.over) game.obstacles = keptObstacles;

  // coin pickup
  const keptCoins = [];
  for (const c of game.coins) {
    const cx = c.x ?? laneCenterX(g, c.lane);
    const cy = c.y;
    const dx = carRect.x + carRect.w / 2 - cx;
    const dy = carRect.y + carRect.h / 2 - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < carRect.w * 0.45 + c.r) {
      if (c.kind === "coin" || c.kind === "bonus") {
        profile.coins += c.value || 1;
        playCoinSfx();
        persistProfile();
        continue;
      }
      // Powerups
      if (c.kind === "magnet") {
        game.magnetUntil = now + 7; // seconds
        toast("🧲 Magnet ON! Coins will pull to you.");
        continue;
      }
      if (c.kind === "slow") {
        game.slowUntil = now + 6.5; // seconds
        toast("🐢 Slow motion! Enemies are slower.");
        continue;
      }
      if (c.kind === "shield") {
        game.shieldUntil = now + 20; // seconds
        toast("🛡 Shield ON! 20s no-crash.");
        continue;
      }
      if (c.kind === "dbl") {
        game.dblUntil = now + 9; // seconds
        toast("⏩ Double-lane move ON! 9s.");
        continue;
      }
      continue;
    }
    keptCoins.push(c);
  }
  game.coins = keptCoins;

  game.obstacles = game.obstacles.filter((o) => o.y < g.safeBottom + 120);
  game.coins = game.coins.filter((c) => c.y < g.safeBottom + 100);
}

// =====================================================
// NEO-BRUTALISM RACING VISUALS (v3)
// Gameplay logic untouched — pure render overhaul.
// Warm, eye-friendly palette for long play sessions.
// =====================================================

function drawRoundedRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// Sharp rect (brutalism — hard corners)
function drawSharpRect(x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.closePath();
}

// =====================================================
// PREMIUM TOP-DOWN CAR (Neo-Brutalism racing style)
// Thick black outlines, flat panel colors with subtle gradient,
// chunky mechanical details — top-notch design.
// =====================================================
function drawCarTopDown(x, y, w, h, bodyColor, opts = {}) {
  ctx.save();

  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
    ctx.restore();
    return;
  }

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const INK = "#0d0d14";
  const CHROME = "#8a8578";
  const CHROME_HI = "#c7c2b0";
  const GLASS_DARK = "#16162a";
  const GLASS_MID = "#1f1f38";
  const accentColor = opts.accent || "#f7d046";
  const isRival = !!opts.rival;

  // ---------- Ground shadow (hard offset — brutalism) ----------
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  drawRoundedRect(x + w * 0.10, y + h * 0.12, w * 0.82, h * 0.88, Math.max(6, w * 0.18));
  ctx.fill();

  // ---------- Body geometry ----------
  const bx = x + w * 0.11;
  const bw = w * 0.78;
  const by = y + h * 0.04;
  const bh = h * 0.93;

  // Aggressive tapered silhouette
  const noseInset = bw * 0.14;   // sharp pointed nose
  const shoulderOut = w * 0.025; // muscular shoulders
  const tailInset = bw * 0.06;

  // ---------- Wheel arches (bold black fenders) ----------
  const wellW = w * 0.095;
  const wellH = h * 0.20;
  ctx.fillStyle = INK;
  // front-left, front-right, rear-left, rear-right arches
  drawRoundedRect(x + w * 0.005, y + h * 0.15, wellW + 2, wellH, 3); ctx.fill();
  drawRoundedRect(x + w - wellW - w * 0.005 - 2, y + h * 0.15, wellW + 2, wellH, 3); ctx.fill();
  drawRoundedRect(x + w * 0.005, y + h * 0.62, wellW + 2, wellH, 3); ctx.fill();
  drawRoundedRect(x + w - wellW - w * 0.005 - 2, y + h * 0.62, wellW + 2, wellH, 3); ctx.fill();

  // Tire treads (chunky detailing)
  ctx.fillStyle = "#1a1a24";
  const tireInsetX = w * 0.018;
  const tireInsetY = h * 0.018;
  [[x + w * 0.005 + tireInsetX, y + h * 0.15 + tireInsetY],
   [x + w - wellW - w * 0.005 - 2 + tireInsetX, y + h * 0.15 + tireInsetY],
   [x + w * 0.005 + tireInsetX, y + h * 0.62 + tireInsetY],
   [x + w - wellW - w * 0.005 - 2 + tireInsetX, y + h * 0.62 + tireInsetY]]
  .forEach(([tx, ty]) => {
    drawRoundedRect(tx, ty, wellW - tireInsetX * 2 + 2, wellH - tireInsetY * 2, 2);
    ctx.fill();
    // tread lines
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const ly = ty + ((wellH - tireInsetY * 2) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(tx + 2, ly);
      ctx.lineTo(tx + wellW - tireInsetX * 2 - 2 + 2, ly);
      ctx.stroke();
    }
    ctx.restore();
  });

  // Chrome rim highlight (subtle metallic)
  ctx.fillStyle = CHROME;
  const rimW = wellW * 0.42, rimH = wellH * 0.32;
  [[x + w * 0.005 + (wellW - rimW) / 2, y + h * 0.15 + (wellH - rimH) / 2],
   [x + w - wellW - w * 0.005 - 2 + (wellW - rimW) / 2, y + h * 0.15 + (wellH - rimH) / 2],
   [x + w * 0.005 + (wellW - rimW) / 2, y + h * 0.62 + (wellH - rimH) / 2],
   [x + w - wellW - w * 0.005 - 2 + (wellW - rimW) / 2, y + h * 0.62 + (wellH - rimH) / 2]]
  .forEach(([rx, ry]) => {
    drawRoundedRect(rx, ry, rimW, rimH, 1.5);
    ctx.fill();
  });

  // ---------- Main body silhouette (aggressive muscle car) ----------
  ctx.beginPath();
  // sharp front nose
  ctx.moveTo(bx + noseInset, by);
  ctx.lineTo(bx + bw - noseInset, by);
  // front shoulder bulge
  ctx.quadraticCurveTo(bx + bw + shoulderOut, by + bh * 0.12, bx + bw, by + bh * 0.30);
  // body side
  ctx.lineTo(bx + bw - tailInset * 0.3, by + bh * 0.80);
  // rear corner
  ctx.quadraticCurveTo(bx + bw, by + bh * 0.94, bx + bw - tailInset, by + bh);
  ctx.lineTo(bx + tailInset, by + bh);
  ctx.quadraticCurveTo(bx, by + bh * 0.94, bx + tailInset * 0.3, by + bh * 0.80);
  ctx.lineTo(bx, by + bh * 0.30);
  ctx.quadraticCurveTo(bx - shoulderOut, by + bh * 0.12, bx + noseInset, by);
  ctx.closePath();

  // Flat body color with subtle panel shading
  const base = String(bodyColor || "#ef476f");
  const bodyGrad = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  bodyGrad.addColorStop(0, _shade(base, -0.12));
  bodyGrad.addColorStop(0.5, base);
  bodyGrad.addColorStop(1, _shade(base, -0.18));
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // BRUTAL thick black outline
  ctx.lineWidth = clamp(w * 0.06, 2, 3.8);
  ctx.strokeStyle = INK;
  ctx.lineJoin = "miter";
  ctx.stroke();

  // ---------- Racing stripes (twin stripes — iconic gaming) ----------
  ctx.save();
  ctx.fillStyle = accentColor;
  const stripeW = bw * 0.08;
  const stripeGap = bw * 0.04;
  // two stripes running length of body
  ctx.fillRect(bx + bw * 0.5 - stripeW - stripeGap / 2, by + bh * 0.06, stripeW, bh * 0.88);
  ctx.fillRect(bx + bw * 0.5 + stripeGap / 2, by + bh * 0.06, stripeW, bh * 0.88);
  // black outlines on stripes
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(bx + bw * 0.5 - stripeW - stripeGap / 2, by + bh * 0.06, stripeW, bh * 0.88);
  ctx.strokeRect(bx + bw * 0.5 + stripeGap / 2, by + bh * 0.06, stripeW, bh * 0.88);
  ctx.restore();

  // ---------- Hood scoop (aggressive detail) ----------
  ctx.save();
  ctx.fillStyle = INK;
  const scoopW = bw * 0.28;
  const scoopH = bh * 0.08;
  drawRoundedRect(bx + (bw - scoopW) / 2, by + bh * 0.12, scoopW, scoopH, 3);
  ctx.fill();
  // inner scoop highlight (looks like air intake)
  ctx.fillStyle = "#2a2a3a";
  drawRoundedRect(bx + (bw - scoopW) / 2 + 3, by + bh * 0.12 + 2, scoopW - 6, scoopH - 4, 2);
  ctx.fill();
  // twin mini vents
  ctx.fillStyle = accentColor;
  ctx.fillRect(bx + (bw - scoopW) / 2 + scoopW * 0.18, by + bh * 0.12 + scoopH * 0.35, scoopW * 0.12, scoopH * 0.3);
  ctx.fillRect(bx + (bw - scoopW) / 2 + scoopW * 0.70, by + bh * 0.12 + scoopH * 0.35, scoopW * 0.12, scoopH * 0.3);
  ctx.restore();

  // ---------- Windshield (chunky trapezoid — glossy dark) ----------
  const fwY = by + bh * 0.26;
  const fwH = bh * 0.20;
  ctx.beginPath();
  ctx.moveTo(bx + bw * 0.20, fwY);
  ctx.lineTo(bx + bw * 0.80, fwY);
  ctx.lineTo(bx + bw * 0.88, fwY + fwH);
  ctx.lineTo(bx + bw * 0.12, fwY + fwH);
  ctx.closePath();
  const glassGrad = ctx.createLinearGradient(0, fwY, 0, fwY + fwH);
  glassGrad.addColorStop(0, GLASS_DARK);
  glassGrad.addColorStop(1, GLASS_MID);
  ctx.fillStyle = glassGrad;
  ctx.fill();
  // hard black outline
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.2, w * 0.022);
  ctx.stroke();
  // windshield reflection (diagonal gaming highlight)
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = accentColor;
  ctx.fillRect(bx + bw * 0.15, fwY, bw * 0.25, fwH);
  ctx.restore();

  // ---------- Roof / cabin ----------
  const roofY = fwY + fwH;
  const roofH = bh * 0.18;
  ctx.beginPath();
  ctx.moveTo(bx + bw * 0.12, roofY);
  ctx.lineTo(bx + bw * 0.88, roofY);
  ctx.lineTo(bx + bw * 0.86, roofY + roofH);
  ctx.lineTo(bx + bw * 0.14, roofY + roofH);
  ctx.closePath();
  ctx.fillStyle = _shade(base, -0.28);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Side mirrors (small chunky blocks)
  ctx.fillStyle = INK;
  ctx.fillRect(bx - 2, roofY + roofH * 0.25, 4, 5);
  ctx.fillRect(bx + bw - 2, roofY + roofH * 0.25, 4, 5);

  // ---------- Rear windshield ----------
  const rwY = roofY + roofH;
  const rwH = bh * 0.14;
  ctx.beginPath();
  ctx.moveTo(bx + bw * 0.14, rwY);
  ctx.lineTo(bx + bw * 0.86, rwY);
  ctx.lineTo(bx + bw * 0.80, rwY + rwH);
  ctx.lineTo(bx + bw * 0.20, rwY + rwH);
  ctx.closePath();
  ctx.fillStyle = GLASS_MID;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // ---------- Headlights (front — crisp squares, not blurry glow) ----------
  ctx.save();
  const hlW = bw * 0.14, hlH = bh * 0.045;
  ctx.fillStyle = "#fff2a8";
  drawRoundedRect(bx + bw * 0.13, by + bh * 0.04, hlW, hlH, 1.5);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  drawRoundedRect(bx + bw - bw * 0.13 - hlW, by + bh * 0.04, hlW, hlH, 1.5);
  ctx.fill();
  ctx.stroke();
  // inner bright core
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx + bw * 0.13 + hlW * 0.25, by + bh * 0.04 + hlH * 0.3, hlW * 0.5, hlH * 0.35);
  ctx.fillRect(bx + bw - bw * 0.13 - hlW + hlW * 0.25, by + bh * 0.04 + hlH * 0.3, hlW * 0.5, hlH * 0.35);
  ctx.restore();

  // ---------- Taillights (rear — bold red blocks) ----------
  ctx.save();
  const tlW = bw * 0.16, tlH = bh * 0.04;
  ctx.fillStyle = "#ef476f";
  drawRoundedRect(bx + bw * 0.11, by + bh * 0.92, tlW, tlH, 1.5);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  drawRoundedRect(bx + bw - bw * 0.11 - tlW, by + bh * 0.92, tlW, tlH, 1.5);
  ctx.fill();
  ctx.stroke();
  // center brake light bar
  ctx.fillStyle = "#ff8fa8";
  ctx.fillRect(bx + bw * 0.38, by + bh * 0.955, bw * 0.24, bh * 0.012);
  ctx.restore();

  // ---------- Rear spoiler wing (chunky GT-style) ----------
  ctx.save();
  ctx.fillStyle = INK;
  drawRoundedRect(bx + bw * 0.08, by + bh * 0.985, bw * 0.84, bh * 0.05, 2);
  ctx.fill();
  // spoiler supports
  ctx.fillRect(bx + bw * 0.22, by + bh * 0.96, 4, bh * 0.045);
  ctx.fillRect(bx + bw - bw * 0.22 - 4, by + bh * 0.96, 4, bh * 0.045);
  ctx.restore();

  // ---------- Exhaust tips (chrome dots on rear) ----------
  ctx.save();
  ctx.fillStyle = CHROME_HI;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  for (let i = 0; i < 2; i++) {
    const ex = bx + bw * (0.40 + i * 0.18);
    drawRoundedRect(ex, by + bh * 1.005, bw * 0.06, bh * 0.02, 1);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // ---------- Rivet/bolt details on hood (gaming detail) ----------
  ctx.save();
  ctx.fillStyle = INK;
  const rivY = by + bh * 0.22;
  for (let i = 0; i < 4; i++) {
    const rx = bx + bw * (0.22 + i * 0.19);
    ctx.beginPath();
    ctx.arc(rx, rivY, Math.max(1, w * 0.018), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Rival car: add angry red accent stripe on sides
  if (isRival) {
    ctx.save();
    ctx.fillStyle = "#ef476f";
    ctx.fillRect(bx + bw * 0.02, by + bh * 0.48, bw * 0.08, bh * 0.12);
    ctx.fillRect(bx + bw * 0.90, by + bh * 0.48, bw * 0.08, bh * 0.12);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + bw * 0.02, by + bh * 0.48, bw * 0.08, bh * 0.12);
    ctx.strokeRect(bx + bw * 0.90, by + bh * 0.48, bw * 0.08, bh * 0.12);
    ctx.restore();
  }

  ctx.restore();
}

// Color shade helper — darken/lighten a hex color
function _shade(hex, amt) {
  const h = String(hex).replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const adj = (c) => {
    const n = Math.round(c + (amt < 0 ? c * amt : (255 - c) * amt));
    return Math.max(0, Math.min(255, n));
  };
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(adj(r))}${toHex(adj(g))}${toHex(adj(b))}`;
}

// Enemy palette — varied brutalist racing colors
const ENEMY_PALETTE = [
  "#ef476f", // coral red
  "#8338ec", // electric purple
  "#ff6b35", // race orange
  "#06d6a0", // mint (rare)
  "#4cc9f0", // soft cyan
  "#e63946", // deep red
  "#52b788", // forest
  "#f77f00"  // amber
];

function pickEnemyColor(o) {
  if (o && o.__brutColor) return o.__brutColor;
  const seed = ((o?.id ?? 0) | 0) + ((o?.lane ?? 0) | 0) * 7 + ((o?.y | 0) % 997);
  const c = ENEMY_PALETTE[Math.abs(seed) % ENEMY_PALETTE.length];
  if (o) o.__brutColor = c;
  return c;
}

function drawPlayerCarPremium(x, y, w, h) {
  // Player car: aggressive yellow/orange racing livery with orange underglow
  ctx.save();

  // Orange underglow (warm, eye-safe — brutalism uses hard offset not soft blur)
  ctx.save();
  ctx.globalAlpha = 0.45;
  const glowGrad = ctx.createRadialGradient(
    x + w / 2, y + h * 0.98, 0,
    x + w / 2, y + h * 0.98, Math.max(w, h) * 0.75
  );
  glowGrad.addColorStop(0, "rgba(255,107,53,0.6)");
  glowGrad.addColorStop(0.4, "rgba(247,208,70,0.22)");
  glowGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glowGrad;
  ctx.fillRect(x - w * 0.5, y - h * 0.05, w * 2, h * 1.4);
  ctx.restore();

  // Player body: champion yellow with orange racing stripes
  const PLAYER_BODY = "#f7d046";
  drawCarTopDown(x, y, w, h, PLAYER_BODY, { accent: "#ff6b35" });

  // Bright headlight glow (forward-pointing)
  ctx.save();
  ctx.globalAlpha = 0.35;
  const hlGrad = ctx.createRadialGradient(x + w / 2, y - 4, 0, x + w / 2, y - 4, w * 0.9);
  hlGrad.addColorStop(0, "rgba(255,250,200,0.7)");
  hlGrad.addColorStop(1, "rgba(255,250,200,0)");
  ctx.fillStyle = hlGrad;
  ctx.fillRect(x - w * 0.3, y - h * 0.25, w * 1.6, h * 0.4);
  ctx.restore();

  ctx.restore();
}

// =====================================================
// SCENE BACKGROUND (grass/city decor cache)
// =====================================================
let _grassDecor = { key: "", blobs: [] };

function _hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function ensureGrassDecor(g) {
  const key = `${Math.round(g.w)}x${Math.round(g.h)}|${Math.round(g.roadX)}|${Math.round(g.roadW)}`;
  if (_grassDecor.key === key) return;
  _grassDecor.key = key;

  const rnd = _mulberry32(_hashSeed(key));
  const blobs = [];

  const sideW = Math.max(0, (g.w - g.roadW) / 2);
  const count = Math.max(16, Math.floor(g.h / 24));

  for (let i = 0; i < count; i++) {
    const left = rnd() < 0.5;
    const xBase = left ? 0 : g.roadX + g.roadW;
    const x = xBase + rnd() * sideW;
    const y = rnd() * g.h;
    // rectangular "billboards" — neo-brutalist
    const bw = 10 + rnd() * 22;
    const bh = 14 + rnd() * 28;
    const kind = rnd(); // 0..1
    blobs.push({ x, y, bw, bh, kind });
  }

  _grassDecor.blobs = blobs;
}

// =====================================================
// MAIN RENDER — Neo-Brutalism Racing Scene (theme-aware)
// Reads colors from CSS variables via getCanvasPalette()
// so Light/Dark switcher works instantly.
// =====================================================
function render() {
  const g = laneGeometry();
  if (!g || !isFinite(g.w) || !isFinite(g.h) || g.w <= 0 || g.h <= 0) return;

  const P = getCanvasPalette();

  // Single top-level save so restore-balance is guaranteed.
  ctx.save();

  // Start with a clean canvas
  ctx.clearRect(0, 0, g.w, g.h);

  // ---------- Background: sky gradient (light day / dark night) ----------
  const sky = ctx.createLinearGradient(0, 0, 0, g.h);
  sky.addColorStop(0, P.skyTop);
  sky.addColorStop(0.5, P.skyMid);
  sky.addColorStop(1, P.skyBot);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, g.w, g.h);

  // ---------- Sideline decorations: brutalist billboards/blocks ----------
  ensureGrassDecor(g);
  ctx.save();
  for (const b of _grassDecor.blobs) {
    if (b.x > g.roadX - 8 && b.x < g.roadX + g.roadW + 8) continue;
    const isLeft = b.x < g.roadX;
    let fillCol;
    if (b.kind < 0.25) fillCol = P.sideFill1;
    else if (b.kind < 0.5) fillCol = isLeft ? P.sideFill2 : P.sideFill3;
    else if (b.kind < 0.75) fillCol = P.sideFill1;
    else fillCol = P.sideAccent;

    ctx.fillStyle = fillCol;
    ctx.fillRect(b.x, b.y, b.bw, b.bh);
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x, b.y, b.bw, b.bh);

    // accent stripe on some billboards
    if (b.kind > 0.75) {
      ctx.fillStyle = P.edgeLeft;
      ctx.fillRect(b.x, b.y + b.bh * 0.35, b.bw, Math.max(2, b.bh * 0.08));
    }
  }
  ctx.restore();

  // ---------- Speed streaks on sides (parallax) ----------
  ctx.save();
  ctx.globalAlpha = 0.35;
  const streakOff = (game.t * (140 + game.speed * 60)) % 60;
  ctx.strokeStyle = P.streakA;
  ctx.lineWidth = 1.5;
  const sideW = Math.max(0, (g.w - g.roadW) / 2);
  for (let i = 0; i < 5; i++) {
    const lx = (i + 0.5) * (sideW / 5);
    const rx = g.roadX + g.roadW + (i + 0.5) * (sideW / 5);
    for (let k = -1; k < Math.ceil(g.h / 60) + 1; k++) {
      const yy = k * 60 + streakOff;
      ctx.beginPath(); ctx.moveTo(lx, yy); ctx.lineTo(lx, yy + 30); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx, yy); ctx.lineTo(rx, yy + 30); ctx.stroke();
    }
  }
  ctx.strokeStyle = P.streakB;
  for (let i = 0; i < 3; i++) {
    const lx = (i + 0.8) * (sideW / 4);
    const rx = g.roadX + g.roadW + (i + 0.2) * (sideW / 4);
    for (let k = -1; k < Math.ceil(g.h / 80) + 1; k++) {
      const yy = k * 80 + (streakOff * 1.3) % 80;
      ctx.beginPath(); ctx.moveTo(lx, yy); ctx.lineTo(lx, yy + 24); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx, yy); ctx.lineTo(rx, yy + 24); ctx.stroke();
    }
  }
  ctx.restore();

  // ---------- Road body ----------
  // Hard offset road shadow (brutalism signature)
  ctx.save();
  ctx.fillStyle = P.roadShadow;
  drawRoundedRect(g.roadX + 5, g.roadY + 7, g.roadW, g.roadH, g.cornerR);
  ctx.fill();
  ctx.restore();

  // Asphalt
  const asphalt = ctx.createLinearGradient(g.roadX, 0, g.roadX + g.roadW, 0);
  asphalt.addColorStop(0, P.asphalt1);
  asphalt.addColorStop(0.5, P.asphalt2);
  asphalt.addColorStop(1, P.asphalt1);
  ctx.fillStyle = asphalt;
  drawRoundedRect(g.roadX, g.roadY, g.roadW, g.roadH, g.cornerR);
  ctx.fill();

  // Asphalt texture dots
  ctx.save();
  drawRoundedRect(g.roadX, g.roadY, g.roadW, g.roadH, g.cornerR);
  ctx.clip();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = P.asphaltDot;
  const seed = Math.round(g.w) * 131 + Math.round(g.h);
  const rnd = _mulberry32(seed);
  const dotCount = Math.floor((g.roadW * g.roadH) / 1000);
  for (let i = 0; i < dotCount; i++) {
    const dx = g.roadX + rnd() * g.roadW;
    const dy = g.roadY + rnd() * g.roadH;
    ctx.fillRect(dx, dy, 1.5, 1.5);
  }
  ctx.restore();

  // Neo-brutalist road edges: racing stripes
  ctx.save();
  ctx.fillStyle = P.edgeLeft;
  ctx.fillRect(g.roadX + 2, g.safeTop, 4, g.safeBottom - g.safeTop);
  ctx.fillStyle = P.edgeRight;
  ctx.fillRect(g.roadX + g.roadW - 6, g.safeTop, 4, g.safeBottom - g.safeTop);

  // Diagonal warning hazard stripes at top/bottom
  ctx.save();
  ctx.globalAlpha = 0.7;
  const hazardY1 = g.safeTop - 4;
  const hazardY2 = g.safeBottom;
  ctx.fillStyle = P.ink;
  ctx.fillRect(g.roadX + 8, hazardY1, g.roadW - 16, 4);
  ctx.fillRect(g.roadX + 8, hazardY2, g.roadW - 16, 4);
  const stripeSpace = 14;
  ctx.fillStyle = P.hazardYel;
  for (let sx = g.roadX + 8; sx < g.roadX + g.roadW - 8; sx += stripeSpace) {
    ctx.beginPath();
    ctx.moveTo(sx, hazardY1);
    ctx.lineTo(sx + 6, hazardY1);
    ctx.lineTo(sx + 10, hazardY1 + 4);
    ctx.lineTo(sx + 4, hazardY1 + 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx, hazardY2);
    ctx.lineTo(sx + 6, hazardY2);
    ctx.lineTo(sx + 10, hazardY2 + 4);
    ctx.lineTo(sx + 4, hazardY2 + 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();

  // Thick black outer road stroke
  ctx.strokeStyle = P.roadStroke;
  ctx.lineWidth = 2.5;
  drawRoundedRect(g.roadX, g.roadY, g.roadW, g.roadH, g.cornerR);
  ctx.stroke();

  // Clip gameplay to road
  ctx.save();
  drawRoundedRect(g.roadX, g.roadY, g.roadW, g.roadH, g.cornerR);
  ctx.clip();

  // ---------- Lane separators — chunky dashes ----------
  const dashSpeed = (220 + game.speed * 90) * (isSlowOn() ? 0.55 : 1.0);
  ctx.save();
  ctx.strokeStyle = P.laneOutl;
  ctx.lineWidth = 6;
  ctx.lineCap = "butt";
  ctx.setLineDash([30, 24]);
  ctx.lineDashOffset = -(game.t * dashSpeed);
  for (let i = 1; i < g.lanes; i++) {
    const x = g.lanesX + g.laneW * i;
    ctx.beginPath();
    ctx.moveTo(x, g.safeTop);
    ctx.lineTo(x, g.safeBottom);
    ctx.stroke();
  }
  ctx.strokeStyle = P.laneDash;
  ctx.lineWidth = 3.5;
  for (let i = 1; i < g.lanes; i++) {
    const x = g.lanesX + g.laneW * i;
    ctx.beginPath();
    ctx.moveTo(x, g.safeTop);
    ctx.lineTo(x, g.safeBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // ---------- Enemy cars ----------
  for (const o of game.obstacles) {
    const ow = o.w ?? o.size;
    const oh = o.h ?? o.size;
    const x = laneCenterX(g, o.lane) - ow / 2;
    const y = o.y;
    const col = o.color && typeof o.color === "string" && o.color.startsWith("#")
      ? o.color
      : pickEnemyColor(o);
    drawCarTopDown(x, y, ow, oh, col, { rival: true, accent: "#0d0d14" });
  }

  // ---------- Coins & power-ups (brutalist badges) ----------
  for (const c of game.coins) {
    const x = c.x ?? laneCenterX(g, c.lane);
    const y = c.y;
    const r = c.r;

    ctx.save();

    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
    ctx.fill();

    // badge colors
    let fill, label, labelCol = "#0d0d14";
    if (c.kind === "coin")       { fill = "#f7d046"; label = ""; }
    else if (c.kind === "bonus") { fill = "#8338ec"; label = `${c.value}x`; labelCol = "#fff"; }
    else if (c.kind === "magnet"){ fill = "#4cc9f0"; label = "M"; }
    else if (c.kind === "slow")  { fill = "#06d6a0"; label = "S"; }
    else if (c.kind === "shield"){ fill = "#c7f464"; label = "L"; }
    else if (c.kind === "dbl")   { fill = "#ff6b35"; label = "2"; }
    else                         { fill = "#f7d046"; label = ""; }

    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#0d0d14";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    if (c.kind === "coin") {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0d0d14";
      ctx.font = `900 ${Math.max(11, r + 3)}px "Akando", ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("$", x, y + 0.5);
    } else if (label) {
      ctx.fillStyle = labelCol;
      ctx.font = `900 ${Math.max(11, r + 2)}px "Akando", ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x, y + 0.5);
    }

    ctx.restore();
  }

  // ---------- Player car ----------
  const carW = Math.max(36, Math.min(60, g.laneW * 0.62));
  const carH = carW * 1.30;
  const carX = (game.playerX ?? laneCenterX(g, game.lane)) - carW / 2;
  const carY = g.safeBottom - carH - 14;

  drawPlayerCarPremium(carX, carY, carW, carH);

  // ---------- Shield effect (if active) ----------
  if (typeof isShieldOn === "function" && isShieldOn()) {
    ctx.save();
    ctx.strokeStyle = "#c7f464";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -(game.t * 40);
    ctx.beginPath();
    ctx.arc(carX + carW / 2, carY + carH / 2, Math.max(carW, carH) * 0.75, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = "#c7f464";
    ctx.beginPath();
    ctx.arc(carX + carW / 2, carY + carH / 2, Math.max(carW, carH) * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // unclip road

  // ---------- Game Over overlay ----------
  if (typeof game !== "undefined" && game.over) {
    ctx.save();
    ctx.fillStyle = P.overlay;
    ctx.fillRect(0, 0, g.w, g.h);

    const bannerW = Math.min(g.w * 0.82, 360);
    const bannerH = 120;
    const bannerX = (g.w - bannerW) / 2;
    const bannerY = (g.h - bannerH) / 2;

    // hard-offset shadow
    ctx.fillStyle = P.bannerSh;
    ctx.fillRect(bannerX + 7, bannerY + 7, bannerW, bannerH);

    // main
    ctx.fillStyle = P.bannerBg;
    ctx.fillRect(bannerX, bannerY, bannerW, bannerH);
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 4;
    ctx.strokeRect(bannerX, bannerY, bannerW, bannerH);

        ctx.fillStyle = P.bannerTtl;
    ctx.font = '800 28px "Akando", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("CRASHED", g.w / 2, bannerY + 38);

    ctx.fillStyle = P.bannerTxt;
    ctx.font = '700 13px "Akando", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText(`SCORE: ${game.score | 0}`, g.w / 2, bannerY + 70);

    ctx.fillStyle = P.bannerSub;
    ctx.font = '700 12px "Akando", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText("TAP TO RESTART", g.w / 2, bannerY + 96);
  }
  ctx.restore(); // final (matches the very first ctx.save())
}


// =====================================================
// MAIN GAME LOOP (MISSING — critical fix)
// - Drives update(dt) + render() every animation frame.
// - Uses capped dt for stable behavior when tab regains focus.
// - Also handles "tap to restart" on Game Over.
// =====================================================
(function startGameLoop() {
  let lastTs = performance.now();
  let running = true;

  function frame(nowTs) {
    try {
      // Cap dt so very large pauses (tab switch) don't break physics.
      const rawDt = (nowTs - lastTs) / 1000;
      const dt = Math.max(0, Math.min(0.05, rawDt)); // cap at 50ms (~20fps floor)
      lastTs = nowTs;

      if (typeof update === "function") update(dt);
      if (typeof render === "function") render();
      if (typeof renderHud === "function") renderHud();

    } catch (e) {
      // Never let a render error stop the loop — log and continue.
      console.error("[gameLoop]", e);
    }
    if (running) requestAnimationFrame(frame);
  }

  // Pause/resume on visibility change to save battery.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
    } else if (!running) {
      running = true;
      lastTs = performance.now(); // reset dt baseline so no jump
      requestAnimationFrame(frame);
    }
  });

  requestAnimationFrame(frame);
})();

// =====================================================
// TAP-TO-RESTART on Game Over
// - When game.over is true, any pointer down on the canvas restarts.
// =====================================================
(function bindTapToRestart() {
  const canvasEl = els && els.c;
  if (!canvasEl) return;
  canvasEl.addEventListener(
    "pointerdown",
    (ev) => {
      if (!game || !game.over) return; // only when dead
      ev.preventDefault();
      ev.stopPropagation();
      try { hapticTap(); } catch {}
      try { resetRun(); } catch {}
    },
    { passive: false, capture: true } // capture so it runs before swipe handler
  );
})();

// =====================================================
// FORCE a resize + first render so canvas is never blank
// even before the very first animation frame kicks in.
// =====================================================
(function forceFirstPaint() {
  try { if (typeof resize === "function") resize(); } catch {}
  try { if (typeof render === "function") render(); } catch {}
})();

