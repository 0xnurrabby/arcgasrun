const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  weekStartUtcMs,
} = require("./lib/db");
const { verifyMessage, parseJsonBody, ok, fail, cors } = require("./lib/auth");

/**
 * Deposit saved points → weekly leaderboard (Neon)
 * Body: { address, points, weekStartMs?, txHash?, timestamp, signature }
 * Message: gasrun:deposit:{address}:{points}:{timestamp}
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
    const txHash = body.txHash || null;
    const week = Number(body.weekStartMs || weekStartUtcMs());

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (points <= 0) return fail(res, 400, "No points");
    if (!signature) return fail(res, 400, "Signature required");
    if (!timestamp || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      return fail(res, 400, "Timestamp expired");
    }

    const msg = `gasrun:deposit:${address}:${points}:${timestamp}`;
    if (!verifyMessage(address, msg, signature)) {
      return fail(res, 401, "Invalid signature");
    }

    const db = getSql();
    await getOrCreateUser(address);
    await db`
      INSERT INTO weekly_scores (address, points, week_start_ms, tx_hash)
      VALUES (${address}, ${points}, ${week}, ${txHash})
    `;
    await db`
      UPDATE users SET
        total_deposited_pts = total_deposited_pts + ${points},
        updated_at = NOW()
      WHERE address = ${address}
    `;

    const user = await getOrCreateUser(address);
    return ok(res, {
      deposited: points,
      weekStartMs: week,
      totalDepositedPts: Number(user.total_deposited_pts || 0),
      txHash,
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
