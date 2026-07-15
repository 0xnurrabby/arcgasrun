const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ARC_CHAIN_ID = 5042002;
const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const ADMIN = (process.env.ADMIN_ADDRESS || "0xe8Bda2Ed9d2FC622D900C8a76dc455A3e79B041f").toLowerCase();

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function usdc() view returns (address)",
  "function balance() view returns (uint256)",
  "function deposit(uint256 amount)",
  "function payout(address to, uint256 amount, bytes32 ref)",
  "function adminWithdraw(address to, uint256 amount)",
  "function setOperator(address newOperator)",
  "function transferOwnership(address newOwner)",
  "event Payout(address indexed to, uint256 amount, bytes32 indexed ref)",
  "event Deposited(address indexed from, uint256 amount)",
  "event AdminWithdraw(address indexed to, uint256 amount)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function loadDeployed() {
  try {
    const p = path.join(process.cwd(), "contracts", "deployed.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {
    vault: process.env.VAULT_ADDRESS || "",
    score: process.env.SCORE_ADDRESS || "",
    usdc: USDC,
    admin: ADMIN,
    operator: process.env.OPERATOR_ADDRESS || "",
    chainId: ARC_CHAIN_ID,
  };
}

function getProvider() {
  return new ethers.JsonRpcProvider(ARC_RPC, { chainId: ARC_CHAIN_ID, name: "arc-testnet" });
}

function getOperatorWallet() {
  const pk = process.env.OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY not set");
  return new ethers.Wallet(pk, getProvider());
}

function getVaultContract(signerOrProvider) {
  const d = loadDeployed();
  const addr = process.env.VAULT_ADDRESS || d.vault;
  if (!addr) throw new Error("VAULT_ADDRESS not configured");
  return new ethers.Contract(addr, VAULT_ABI, signerOrProvider || getProvider());
}

function getUsdc(signerOrProvider) {
  const d = loadDeployed();
  return new ethers.Contract(d.usdc || USDC, ERC20_ABI, signerOrProvider || getProvider());
}

async function vaultBalance() {
  const vault = getVaultContract();
  return await vault.balance();
}

async function payoutUsdc(to, amountMicros, ref) {
  const wallet = getOperatorWallet();
  const vault = getVaultContract(wallet);
  const refBytes =
    typeof ref === "string" && ref.startsWith("0x") && ref.length === 66
      ? ref
      : ethers.id(String(ref || `${to}-${amountMicros}-${Date.now()}`));
  const tx = await vault.payout(to, BigInt(amountMicros), refBytes);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, ref: refBytes };
}

async function adminWithdrawUsdc(to, amountMicros) {
  // Owner must be the operator wallet OR we use owner key
  const pk = process.env.OWNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("OWNER_PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(pk, getProvider());
  const vault = getVaultContract(wallet);
  const tx = await vault.adminWithdraw(to, BigInt(amountMicros));
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

module.exports = {
  ARC_CHAIN_ID,
  ARC_RPC,
  USDC,
  ADMIN,
  VAULT_ABI,
  ERC20_ABI,
  loadDeployed,
  getProvider,
  getOperatorWallet,
  getVaultContract,
  getUsdc,
  vaultBalance,
  payoutUsdc,
  adminWithdrawUsdc,
};
