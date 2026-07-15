const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  usdcMicrosToDisplay,
  pointsToUsdcMicros,
} = require("./lib/db");
const { parseJsonBody, ok, fail, cors } = require("./lib/auth");
const { onChainCredit } = require("./lib/chain");

/**
 * After on-chain convert tx confirms — sync DB
 * Body: { address, points, txHash }
 */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return fail(res, 405, "POST only");

  try {
    await ensureSchema();
    const body = parseJsonBody(req);
    const address = normAddr(body.address);
    const points = Math.floor(Number(body.points) || 0);
    const txHash = body.txHash || null;

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (points <= 0) return fail(res, 400, "No points");

    const usdcMicros = pointsToUsdcMicros(points);
    const db = getSql();
    await getOrCreateUser(address);

    // Sync credit from chain as source of truth
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
      // fallback: add converted amount
      await db`
        UPDATE users SET
          usdc_balance_micros = usdc_balance_micros + ${usdcMicros.toString()},
          updated_at = NOW()
        WHERE address = ${address}
      `;
    }

    await db`
      INSERT INTO conversions (address, points, usdc_micros)
      VALUES (${address}, ${points}, ${usdcMicros.toString()})
    `;

    const user = await getOrCreateUser(address);
    return ok(res, {
      txHash,
      points,
      usdcAdded: usdcMicrosToDisplay(usdcMicros),
      usdcBalance: usdcMicrosToDisplay(user.usdc_balance_micros),
      usdcBalanceMicros: String(user.usdc_balance_micros),
      chainCredit: usdcMicrosToDisplay(chainCredit),
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
