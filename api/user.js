const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  usdcMicrosToDisplay,
  POINTS_PER_USDC,
  MIN_WITHDRAW_MICROS,
} = require("./lib/db");
const { ok, fail, cors } = require("./lib/auth");
const { onChainCredit, getCoreAddress } = require("./lib/chain");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    await ensureSchema();
    const address = normAddr(req.query.address || "");
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      return fail(res, 400, "Valid address required");
    }

    const user = await getOrCreateUser(address);

    // Prefer on-chain permanent USDC credit as source of truth
    let creditMicros = String(user.usdc_balance_micros || 0);
    try {
      const chain = await onChainCredit(address);
      creditMicros = chain.toString();
      if (creditMicros !== String(user.usdc_balance_micros || 0)) {
        const db = getSql();
        await db`
          UPDATE users SET usdc_balance_micros = ${creditMicros}, updated_at = NOW()
          WHERE address = ${address}
        `;
      }
    } catch {}

    return ok(res, {
      user: {
        address: user.address,
        bankPoints: Number(user.bank_points || 0),
        usdcBalance: usdcMicrosToDisplay(creditMicros),
        usdcBalanceMicros: creditMicros,
        totalDepositedPts: Number(user.total_deposited_pts || 0),
        coins: Number(user.coins || 0),
      },
      rates: {
        pointsPerUsdc: POINTS_PER_USDC,
        minWithdrawUsdc: "0",
        minWithdrawMicros: "1",
      },
      core: getCoreAddress(),
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
