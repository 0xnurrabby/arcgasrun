const {
  ensureSchema,
  getSql,
  getOrCreateUser,
  normAddr,
  usdcMicrosToDisplay,
  MIN_WITHDRAW_MICROS,
  USDC_MICROS_PER_UNIT,
} = require("./lib/db");
const { verifyMessage, parseJsonBody, ok, fail, cors } = require("./lib/auth");
const { payoutUsdc, vaultBalance, loadDeployed } = require("./lib/chain");

/**
 * Instant USDC withdraw via GasRunVault
 * Body: { address, usdc (number, whole units) OR usdcMicros, timestamp, signature }
 * Message: gasrun:withdraw:{address}:{usdcMicros}:{timestamp}
 */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return fail(res, 405, "POST only");

  try {
    await ensureSchema();
    const body = parseJsonBody(req);
    const address = normAddr(body.address);
    let usdcMicros = body.usdcMicros != null
      ? BigInt(body.usdcMicros)
      : BigInt(Math.floor(Number(body.usdc || 0) * USDC_MICROS_PER_UNIT));
    const timestamp = Number(body.timestamp || 0);
    const signature = body.signature;

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (usdcMicros < BigInt(MIN_WITHDRAW_MICROS)) {
      return fail(res, 400, "Minimum withdraw is 1 USDC");
    }
    if (usdcMicros % BigInt(USDC_MICROS_PER_UNIT) !== 0n) {
      return fail(res, 400, "Withdraw whole USDC only (min 1)");
    }
    if (!signature) return fail(res, 400, "Signature required");
    if (!timestamp || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      return fail(res, 400, "Timestamp expired");
    }

    const msg = `gasrun:withdraw:${address}:${usdcMicros.toString()}:${timestamp}`;
    if (!verifyMessage(address, msg, signature)) {
      return fail(res, 401, "Invalid signature");
    }

    const deployed = loadDeployed();
    if (!deployed.vault && !process.env.VAULT_ADDRESS) {
      return fail(res, 503, "Vault not deployed yet");
    }

    const db = getSql();
    const user = await getOrCreateUser(address);
    const bal = BigInt(user.usdc_balance_micros || 0);
    if (bal < usdcMicros) {
      return fail(res, 400, "Insufficient permanent USDC balance", {
        balance: usdcMicrosToDisplay(bal),
      });
    }

    // Check vault liquidity
    const vBal = await vaultBalance();
    if (vBal < usdcMicros) {
      return fail(res, 503, "Vault underfunded — contact admin", {
        vaultBalance: usdcMicrosToDisplay(vBal),
      });
    }

    const ref = `wd-${address.slice(2, 10)}-${timestamp}-${usdcMicros.toString()}`;

    // Reserve balance first
    const reserved = await db`
      UPDATE users SET
        usdc_balance_micros = usdc_balance_micros - ${usdcMicros.toString()},
        updated_at = NOW()
      WHERE address = ${address} AND usdc_balance_micros >= ${usdcMicros.toString()}
      RETURNING *
    `;
    if (!reserved[0]) {
      return fail(res, 400, "Insufficient balance (race)");
    }

    await db`
      INSERT INTO withdrawals (address, usdc_micros, status, ref)
      VALUES (${address}, ${usdcMicros.toString()}, 'pending', ${ref})
    `;

    try {
      const { txHash, ref: refBytes } = await payoutUsdc(address, usdcMicros.toString(), ref);
      await db`
        UPDATE withdrawals SET
          status = 'completed',
          tx_hash = ${txHash},
          completed_at = NOW()
        WHERE ref = ${ref}
      `;
      const updated = await getOrCreateUser(address);
      return ok(res, {
        txHash,
        ref,
        refBytes,
        amount: usdcMicrosToDisplay(usdcMicros),
        amountMicros: usdcMicros.toString(),
        usdcBalance: usdcMicrosToDisplay(updated.usdc_balance_micros),
        explorer: `https://testnet.arcscan.app/tx/${txHash}`,
      });
    } catch (txErr) {
      // refund
      await db`
        UPDATE users SET
          usdc_balance_micros = usdc_balance_micros + ${usdcMicros.toString()},
          updated_at = NOW()
        WHERE address = ${address}
      `;
      await db`
        UPDATE withdrawals SET
          status = 'failed',
          error = ${String(txErr?.message || txErr)}
        WHERE ref = ${ref}
      `;
      return fail(res, 500, "On-chain payout failed: " + (txErr?.message || String(txErr)));
    }
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
