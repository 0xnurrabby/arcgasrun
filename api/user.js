const {
  ensureSchema,
  getOrCreateUser,
  normAddr,
  usdcMicrosToDisplay,
  POINTS_PER_USDC,
  MIN_WITHDRAW_MICROS,
} = require("./lib/db");
const { ok, fail, cors } = require("./lib/auth");

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
    return ok(res, {
      user: {
        address: user.address,
        bankPoints: Number(user.bank_points || 0),
        usdcBalance: usdcMicrosToDisplay(user.usdc_balance_micros),
        usdcBalanceMicros: String(user.usdc_balance_micros || 0),
        totalDepositedPts: Number(user.total_deposited_pts || 0),
        coins: Number(user.coins || 0),
      },
      rates: {
        pointsPerUsdc: POINTS_PER_USDC,
        minWithdrawUsdc: "0.100000",
        minWithdrawMicros: String(MIN_WITHDRAW_MICROS),
      },
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
