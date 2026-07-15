const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ARC_CHAIN_ID = 5042002;
const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
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

// Keep VAULT_ABI alias for older admin paths
const VAULT_ABI = CORE_ABI;

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

function getProvider() {
  return new ethers.JsonRpcProvider(ARC_RPC, { chainId: ARC_CHAIN_ID, name: "arc-testnet" });
}

function getOperatorWallet() {
  const pk = process.env.OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY not set");
  return new ethers.Wallet(pk, getProvider());
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

async function vaultBalance() {
  const core = getCoreContract();
  return await core.balance();
}

async function onChainCredit(address) {
  const core = getCoreContract();
  return await core.usdcCredit(address);
}

async function getConvertNonce(address) {
  const core = getCoreContract();
  return await core.getNonce(address);
}

/**
 * Sign convert voucher for user (operator key)
 * Message: keccak256(user, points, usdcMicros, nonce, deadline, chainId, core)
 */
async function signConvertVoucher(user, points, usdcMicros, deadline) {
  const wallet = getOperatorWallet();
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

async function payoutUsdc(to, amountMicros, ref) {
  const wallet = getOperatorWallet();
  const vault = getCoreContract(wallet);
  const refBytes =
    typeof ref === "string" && ref.startsWith("0x") && ref.length === 66
      ? ref
      : ethers.id(String(ref || `${to}-${amountMicros}-${Date.now()}`));
  const tx = await vault.payout(to, BigInt(amountMicros), refBytes);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, ref: refBytes };
}

async function adminWithdrawUsdc(to, amountMicros) {
  const pk = process.env.OWNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("OWNER_PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(pk, getProvider());
  const vault = getCoreContract(wallet);
  const tx = await vault.adminWithdraw(to, BigInt(amountMicros));
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

module.exports = {
  ARC_CHAIN_ID,
  ARC_RPC,
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
