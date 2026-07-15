const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  pointsToUsdcMicros,
  usdcMicrosToDisplay,
  POINTS_PER_USDC,
} = require("./lib/db");
const { verifyMessage, parseJsonBody, ok, fail, cors } = require("./lib/auth");

/**
 * Convert saved points → permanent USDC balance
 * 1000 points = 1 USDC
 * Body: { address, points, timestamp, signature }
 * Message: gasrun:convert:{address}:{points}:{timestamp}
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
    const timestamp = Number(body.timestamp || 0);
    const signature = body.signature;

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (points < POINTS_PER_USDC) {
      return fail(res, 400, `Minimum convert is ${POINTS_PER_USDC} points (1 USDC)`);
    }
    // Only whole USDC units
    if (points % POINTS_PER_USDC !== 0) {
      return fail(res, 400, `Points must be multiple of ${POINTS_PER_USDC}`);
    }
    if (!signature) return fail(res, 400, "Signature required");
    if (!timestamp || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      return fail(res, 400, "Timestamp expired (10 min window)");
    }

    const msg = `gasrun:convert:${address}:${points}:${timestamp}`;
    if (!verifyMessage(address, msg, signature)) {
      return fail(res, 401, "Invalid signature");
    }

    const usdcMicros = pointsToUsdcMicros(points);
    const db = getSql();
    await getOrCreateUser(address);

    // Credit permanent USDC balance (points already held client-side / bank)
    await db`
      UPDATE users SET
        usdc_balance_micros = usdc_balance_micros + ${usdcMicros.toString()},
        updated_at = NOW()
      WHERE address = ${address}
    `;
    await db`
      INSERT INTO conversions (address, points, usdc_micros)
      VALUES (${address}, ${points}, ${usdcMicros.toString()})
    `;

    const user = await getOrCreateUser(address);
    return ok(res, {
      convertedPoints: points,
      usdcAdded: usdcMicrosToDisplay(usdcMicros),
      usdcAddedMicros: usdcMicros.toString(),
      usdcBalance: usdcMicrosToDisplay(user.usdc_balance_micros),
      usdcBalanceMicros: String(user.usdc_balance_micros),
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
