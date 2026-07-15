const {
  ensureSchema,
  getOrCreateUser,
  normAddr,
  pointsToUsdcMicros,
  usdcMicrosToDisplay,
} = require("./lib/db");
const { parseJsonBody, ok, fail, cors } = require("./lib/auth");
const { signConvertVoucher, getCoreAddress, ARC_CHAIN_ID } = require("./lib/chain");

/**
 * Prepare on-chain convert voucher (operator-signed)
 * Body: { address, points }
 * Returns: { points, usdcMicros, deadline, signature, nonce, core, chainId }
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

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (points <= 0) return fail(res, 400, "No points");

    const usdcMicros = pointsToUsdcMicros(points);
    if (usdcMicros <= 0n) return fail(res, 400, "USDC amount too small");

    await getOrCreateUser(address);

    const deadline = Math.floor(Date.now() / 1000) + 15 * 60; // 15 min
    const voucher = await signConvertVoucher(address, points, usdcMicros.toString(), deadline);

    return ok(res, {
      points,
      usdcMicros: usdcMicros.toString(),
      usdcDisplay: usdcMicrosToDisplay(usdcMicros),
      deadline,
      signature: voucher.signature,
      nonce: voucher.nonce,
      core: getCoreAddress(),
      chainId: ARC_CHAIN_ID,
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
