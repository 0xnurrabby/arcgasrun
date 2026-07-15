const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  pointsToUsdcMicros,
  usdcMicrosToDisplay,
} = require("./lib/db");
const { verifyMessage, parseJsonBody, ok, fail, cors } = require("./lib/auth");
const { signConvertVoucher, getCoreAddress, ARC_CHAIN_ID, onChainCredit } = require("./lib/chain");

/**
 * POST /api/convert
 * body.action:
 *  - "voucher"  → operator-signed convert voucher for on-chain convert()
 *  - "confirm"  → after on-chain convert tx, sync DB
 *  - default    → legacy off-chain convert (signature only)
 */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return fail(res, 405, "POST only");

  try {
    await ensureSchema();
    const body = parseJsonBody(req);
    const action = String(body.action || "legacy");

    if (action === "voucher") {
      const address = normAddr(body.address);
      const points = Math.floor(Number(body.points) || 0);
      if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
      if (points <= 0) return fail(res, 400, "No points");
      const usdcMicros = pointsToUsdcMicros(points);
      if (usdcMicros <= 0n) return fail(res, 400, "USDC amount too small");
      await getOrCreateUser(address);
      const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
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
    }

    if (action === "confirm") {
      const address = normAddr(body.address);
      const points = Math.floor(Number(body.points) || 0);
      const txHash = body.txHash || null;
      if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
      if (points <= 0) return fail(res, 400, "No points");
      const usdcMicros = pointsToUsdcMicros(points);
      const db = getSql();
      await getOrCreateUser(address);
      let chainCredit = "0";
      try {
        chainCredit = (await onChainCredit(address)).toString();
        await db`
          UPDATE users SET usdc_balance_micros = ${chainCredit}, updated_at = NOW()
          WHERE address = ${address}
        `;
      } catch {
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
    }

    // legacy personal_sign convert
    const address = normAddr(body.address);
    const points = Math.floor(Number(body.points) || 0);
    const timestamp = Number(body.timestamp || 0);
    const signature = body.signature;
    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (points <= 0) return fail(res, 400, "No points to convert");
    if (!signature) return fail(res, 400, "Signature required");
    if (!timestamp || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      return fail(res, 400, "Timestamp expired (10 min window)");
    }
    const msg = `gasrun:convert:${address}:${points}:${timestamp}`;
    if (!verifyMessage(address, msg, signature)) return fail(res, 401, "Invalid signature");

    const usdcMicros = pointsToUsdcMicros(points);
    const db = getSql();
    await getOrCreateUser(address);
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
