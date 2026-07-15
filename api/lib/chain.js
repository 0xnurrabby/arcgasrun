const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ARC_CHAIN_ID = 5042002;
const ARC_NETWORK = Object.freeze({
  chainId: ARC_CHAIN_ID,
  name: "arc-testnet",
});

// Public Arc RPCs — rotate on rate limit
const RPC_LIST = [
  process.env.ARC_RPC_URL,
  "https://rpc.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network",
  "https://rpc.drpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
].filter(Boolean);

// unique preserve order
const ARC_RPCS = [...new Set(RPC_LIST)];
const ARC_RPC = ARC_RPCS[0] || "https://rpc.testnet.arc.network";

const USDC = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const ADMIN = (process.env.ADMIN_ADDRESS || "0xe8Bda2Ed9d2FC622D900C8a76dc455A3e79B041f").toLowerCase();

const CORE_ABI = [
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function usdc() view returns (address)",
  "function balance() view returns (uint256)",
  "function nativeBalance() view returns (uint256)",
  "function usdcCredit(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function getNonce(address) view returns (uint256)",
  "function totalScoreDeposited(address) view returns (uint256)",
  "function saveRun(uint256 points)",
  "function depositScore(uint256 points, uint256 weekStart)",
  "function convert(uint256 points, uint256 usdcMicros, uint256 deadline, bytes signature)",
  "function withdraw(uint256 usdcMicros)",
  "function depositErc20(uint256 amount)",
  "function credit(address to, uint256 usdcMicros, bytes32 ref)",
  "function payout(address to, uint256 amount, bytes32 ref)",
  "function adminWithdraw(address to, uint256 amount)",
  "function setOperator(address newOperator)",
  "function transferOwnership(address newOwner)",
  "event RunSaved(address indexed user, uint256 points, uint256 timestamp)",
  "event ScoreDeposited(address indexed user, uint256 points, uint256 weekStart, uint256 timestamp)",
  "event Converted(address indexed user, uint256 points, uint256 usdcMicros, uint256 timestamp)",
  "event Withdrawn(address indexed user, uint256 usdcMicros, uint256 timestamp)",
  "event Payout(address indexed to, uint256 amount, bytes32 indexed ref)",
  "event Funded(address indexed from, uint256 amount, bool isNative)",
  "event AdminWithdraw(address indexed to, uint256 amount)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const VAULT_ABI = CORE_ABI;

let rpcIndex = 0;
let payoutChain = Promise.resolve();
let lastPayoutAt = 0;
const MIN_PAYOUT_GAP_MS = Number(process.env.PAYOUT_GAP_MS || 2500);

function loadDeployed() {
  try {
    const p = path.join(process.cwd(), "contracts", "deployed.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {
    core: process.env.CORE_ADDRESS || process.env.VAULT_ADDRESS || "",
    vault: process.env.VAULT_ADDRESS || process.env.CORE_ADDRESS || "",
    score: process.env.SCORE_ADDRESS || process.env.CORE_ADDRESS || "",
    usdc: USDC,
    admin: ADMIN,
    operator: process.env.OPERATOR_ADDRESS || "",
    chainId: ARC_CHAIN_ID,
  };
}

function getCoreAddress() {
  const d = loadDeployed();
  return process.env.CORE_ADDRESS || process.env.VAULT_ADDRESS || d.core || d.vault || "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  const code = e?.code || e?.error?.code || e?.info?.error?.code;
  return (
    code === -32011 ||
    code === 429 ||
    msg.includes("request limit") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("over rate") ||
    msg.includes("could not coalesce")
  );
}

function makeProvider(rpcUrl) {
  // Static network avoids extra eth_chainId network detection spam
  const provider = new ethers.JsonRpcProvider(rpcUrl, ARC_NETWORK, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  return provider;
}

function getProvider() {
  const url = ARC_RPCS[rpcIndex % ARC_RPCS.length];
  return makeProvider(url);
}

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % ARC_RPCS.length;
  return ARC_RPCS[rpcIndex];
}

function getOperatorWallet(provider) {
  const pk = process.env.OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY not set");
  return new ethers.Wallet(pk, provider || getProvider());
}

function getCoreContract(signerOrProvider) {
  const addr = getCoreAddress();
  if (!addr) throw new Error("CORE_ADDRESS / VAULT_ADDRESS not configured");
  return new ethers.Contract(addr, CORE_ABI, signerOrProvider || getProvider());
}

function getVaultContract(signerOrProvider) {
  return getCoreContract(signerOrProvider);
}

function getUsdc(signerOrProvider) {
  const d = loadDeployed();
  return new ethers.Contract(d.usdc || USDC, ERC20_ABI, signerOrProvider || getProvider());
}

async function withRpcRetry(fn, { tries = 6, label = "rpc" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const rpc = ARC_RPCS[(rpcIndex + i) % ARC_RPCS.length];
    try {
      const provider = makeProvider(rpc);
      return await fn(provider, rpc);
    } catch (e) {
      lastErr = e;
      if (isRateLimitError(e) || String(e?.message || "").includes("fetch failed")) {
        rotateRpc();
        await sleep(400 * (i + 1) + Math.floor(Math.random() * 300));
        continue;
      }
      // non-rate errors: one rotate + retry once more
      if (i < tries - 1) {
        rotateRpc();
        await sleep(200 * (i + 1));
        continue;
      }
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

async function vaultBalance() {
  return withRpcRetry(async (provider) => {
    const core = getCoreContract(provider);
    return await core.balance();
  }, { label: "vaultBalance" });
}

async function onChainCredit(address) {
  return withRpcRetry(async (provider) => {
    const core = getCoreContract(provider);
    return await core.usdcCredit(address);
  }, { label: "onChainCredit" });
}

async function getConvertNonce(address) {
  return withRpcRetry(async (provider) => {
    const core = getCoreContract(provider);
    return await core.getNonce(address);
  }, { label: "getConvertNonce" });
}

async function signConvertVoucher(user, points, usdcMicros, deadline) {
  const wallet = getOperatorWallet(); // local sign — no RPC
  const core = getCoreAddress();
  const nonce = await getConvertNonce(user);
  const payload = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint256", "uint256", "uint256", "uint256", "address"],
      [user, BigInt(points), BigInt(usdcMicros), BigInt(nonce), BigInt(deadline), BigInt(ARC_CHAIN_ID), core]
    )
  );
  const signature = await wallet.signMessage(ethers.getBytes(payload));
  return { signature, nonce: nonce.toString(), deadline, payload, core };
}

/**
 * Serialize payouts + gap + multi-RPC retry to avoid public RPC rate limits.
 */
async function payoutUsdc(to, amountMicros, ref) {
  const run = async () => {
    // gap between operator txs
    const wait = MIN_PAYOUT_GAP_MS - (Date.now() - lastPayoutAt);
    if (wait > 0) await sleep(wait);

    const refBytes =
      typeof ref === "string" && ref.startsWith("0x") && ref.length === 66
        ? ref
        : ethers.id(String(ref || `${to}-${amountMicros}-${Date.now()}`));

    return withRpcRetry(
      async (provider) => {
        const wallet = getOperatorWallet(provider);
        const vault = getCoreContract(wallet);

        // Explicit gas settings reduce extra estimate spam under rate limit
        let gasLimit;
        try {
          gasLimit = await vault.payout.estimateGas(to, BigInt(amountMicros), refBytes);
          gasLimit = (gasLimit * 120n) / 100n;
        } catch {
          gasLimit = 250000n;
        }

        const tx = await vault.payout(to, BigInt(amountMicros), refBytes, { gasLimit });
        const receipt = await tx.wait();
        lastPayoutAt = Date.now();
        return { txHash: receipt.hash, ref: refBytes };
      },
      { tries: 8, label: "payout" }
    );
  };

  // queue so concurrent withdraws don't stampede RPC
  const result = payoutChain.then(run, run);
  payoutChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function adminWithdrawUsdc(to, amountMicros) {
  const pk = process.env.OWNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("OWNER_PRIVATE_KEY not set");

  return withRpcRetry(async (provider) => {
    const wallet = new ethers.Wallet(pk, provider);
    const vault = getCoreContract(wallet);
    const tx = await vault.adminWithdraw(to, BigInt(amountMicros));
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }, { tries: 6, label: "adminWithdraw" });
}

module.exports = {
  ARC_CHAIN_ID,
  ARC_RPC,
  ARC_RPCS,
  USDC,
  ADMIN,
  CORE_ABI,
  VAULT_ABI,
  ERC20_ABI,
  loadDeployed,
  getCoreAddress,
  getProvider,
  getOperatorWallet,
  getCoreContract,
  getVaultContract,
  getUsdc,
  vaultBalance,
  onChainCredit,
  getConvertNonce,
  signConvertVoucher,
  payoutUsdc,
  adminWithdrawUsdc,
};
