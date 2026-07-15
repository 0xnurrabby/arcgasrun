import { ethers } from "ethers";
import { neon } from "@neondatabase/serverless";

const sql = neon(
  process.env.DATABASE_URL ||
    "postgresql://neondb_owner:npg_uIjqyceN90YA@ep-solitary-paper-at24gjnq.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require"
);
const pk =
  process.env.DEPLOYER_PRIVATE_KEY ||
  "0xdf43d1545f8be3c8cc95f0737e64f7241cc05b9a90a470d61cc2a728809d4216";
const coreAddr = "0x3d61d1083f53A431899b800b12B5e1ff4fD256de";

const p = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network", {
  chainId: 5042002,
  name: "arc",
});
const w = new ethers.Wallet(pk, p);
const core = new ethers.Contract(
  coreAddr,
  [
    "function credit(address to, uint256 usdcMicros, bytes32 ref)",
    "function usdcCredit(address) view returns (uint256)",
    "function balance() view returns (uint256)",
  ],
  w
);

const users = await sql`
  SELECT address, usdc_balance_micros::text AS m
  FROM users
  WHERE usdc_balance_micros > 0
`;
console.log("users", users);
console.log("vault bal", (await core.balance()).toString());
console.log("op gas", (await p.getBalance(w.address)).toString());

for (const u of users) {
  const cur = await core.usdcCredit(u.address);
  console.log(u.address, "chain", cur.toString(), "db", u.m);
  if (cur === 0n && BigInt(u.m) > 0n) {
    const ref = ethers.id("migrate-" + u.address + "-" + u.m);
    const tx = await core.credit(u.address, BigInt(u.m), ref);
    console.log("credit tx", tx.hash);
    await tx.wait();
    console.log("new credit", (await core.usdcCredit(u.address)).toString());
  }
}
console.log("done");
