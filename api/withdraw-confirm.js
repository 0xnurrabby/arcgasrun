const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  usdcMicrosToDisplay,
} = require("./lib/db");
const { parseJsonBody, ok, fail, cors } = require("./lib/auth");
const { onChainCredit } = require("./lib/chain");

/**
 * After user on-chain withdraw — sync DB + log
 * Body: { address, usdcMicros, txHash }
 */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return fail(res, 405, "POST only");

  try {
    await ensureSchema();
    const body = parseJsonBody(req);
    const address = normAddr(body.address);
    const usdcMicros = BigInt(body.usdcMicros || 0);
    const txHash = body.txHash || null;

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (usdcMicros <= 0n) return fail(res, 400, "Invalid amount");

    const db = getSql();
    await getOrCreateUser(address);

    let chainCredit = "0";
    try {
      chainCredit = (await onChainCredit(address)).toString();
      await db`
        UPDATE users SET
          usdc_balance_micros = ${chainCredit},
          updated_at = NOW()
        WHERE address = ${address}
      `;
    } catch {
      await db`
        UPDATE users SET
          usdc_balance_micros = GREATEST(usdc_balance_micros - ${usdcMicros.toString()}, 0),
          updated_at = NOW()
        WHERE address = ${address}
      `;
    }

    const ref = `onchain-wd-${txHash || Date.now()}`;
    await db`
      INSERT INTO withdrawals (address, usdc_micros, status, ref, tx_hash, completed_at)
      VALUES (${address}, ${usdcMicros.toString()}, 'completed', ${ref}, ${txHash}, NOW())
      ON CONFLICT (ref) DO NOTHING
    `;

    const user = await getOrCreateUser(address);
    return ok(res, {
      txHash,
      amount: usdcMicrosToDisplay(usdcMicros),
      usdcBalance: usdcMicrosToDisplay(user.usdc_balance_micros),
      usdcBalanceMicros: String(user.usdc_balance_micros),
      explorer: txHash ? `https://testnet.arcscan.app/tx/${txHash}` : null,
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
