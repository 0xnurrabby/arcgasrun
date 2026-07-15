import fs from "fs";
import path from "path";
import solc from "solc";
import { ethers } from "ethers";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const ADMIN = process.env.ADMIN_ADDRESS || "0xe8Bda2Ed9d2FC622D900C8a76dc455A3e79B041f";
const PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ||
  "0xdf43d1545f8be3c8cc95f0737e64f7241cc05b9a90a470d61cc2a728809d4216";

function compile(fileName, contractName) {
  const source = fs.readFileSync(path.join(root, "contracts", fileName), "utf8");
  const input = {
    language: "Solidity",
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors?.some((e) => e.severity === "error")) {
    console.error(out.errors);
    throw new Error("Compile failed");
  }
  const c = out.contracts[fileName][contractName];
  return { abi: c.abi, bytecode: c.evm.bytecode.object };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(ARC_RPC, { chainId: 5042002, name: "arc-testnet" });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);
  console.log("Balance:", (await provider.getBalance(wallet.address)).toString());

  const art = compile("GasRunCore.sol", "GasRunCore");
  const Factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const core = await Factory.deploy(USDC, ADMIN, wallet.address);
  await core.waitForDeployment();
  const coreAddr = await core.getAddress();
  console.log("GasRunCore:", coreAddr);

  // Fund with 50 native USDC for withdraw liquidity
  const fund = await wallet.sendTransaction({
    to: coreAddr,
    value: ethers.parseEther("50"),
  });
  await fund.wait();
  console.log("Funded 50 USDC:", fund.hash);

  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], provider);
  console.log("core erc20 bal:", (await usdc.balanceOf(coreAddr)).toString());
  console.log("core native bal:", (await provider.getBalance(coreAddr)).toString());

  const deployed = {
    core: coreAddr,
    vault: coreAddr, // core replaces vault
    score: coreAddr, // core replaces score
    usdc: USDC,
    admin: ADMIN,
    operator: wallet.address,
    chainId: 5042002,
    name: "GasRunCore",
  };

  fs.writeFileSync(path.join(root, "contracts", "deployed.json"), JSON.stringify(deployed, null, 2));
  fs.writeFileSync(
    path.join(root, "contracts", "GasRunCore.abi.json"),
    JSON.stringify(art.abi, null, 2)
  );
  fs.writeFileSync(
    path.join(root, "contracts-config.js"),
    `// Auto-generated — GasRunCore (all on-chain movements)
window.__GASRUN_CONTRACTS = {
  chainId: 5042002,
  usdc: "${USDC}",
  core: "${coreAddr}",
  score: "${coreAddr}",
  vault: "${coreAddr}",
  admin: "${ADMIN}",
  operator: "${wallet.address}"
};
`
  );

  // patch .env
  try {
    const envPath = path.join(root, ".env");
    let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const set = (k, v) => {
      const re = new RegExp(`^${k}=.*$`, "m");
      if (re.test(env)) env = env.replace(re, `${k}=${v}`);
      else env += `\n${k}=${v}`;
    };
    set("VAULT_ADDRESS", coreAddr);
    set("SCORE_ADDRESS", coreAddr);
    set("CORE_ADDRESS", coreAddr);
    fs.writeFileSync(envPath, env.trim() + "\n");
  } catch {}

  console.log("\nDone. Core address:", coreAddr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
