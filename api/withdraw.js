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
const { payoutUsdc, vaultBalance, loadDeployed, onChainCredit } = require("./lib/chain");

/**
 * POST /api/withdraw
 * body.action:
 *  - "confirm" → after user on-chain withdraw() tx
 *  - default   → operator payout path (legacy)
 */
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return fail(res, 405, "POST only");

  try {
    await ensureSchema();
    const body = parseJsonBody(req);
    const action = String(body.action || "payout");

    if (action === "confirm") {
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
          UPDATE users SET usdc_balance_micros = ${chainCredit}, updated_at = NOW()
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
    }

    // legacy operator payout
    const address = normAddr(body.address);
    let usdcMicros =
      body.usdcMicros != null
        ? BigInt(body.usdcMicros)
        : BigInt(Math.floor(Number(body.usdc || 0) * USDC_MICROS_PER_UNIT));
    const timestamp = Number(body.timestamp || 0);
    const signature = body.signature;

    if (!/^0x[a-f0-9]{40}$/.test(address)) return fail(res, 400, "Invalid address");
    if (usdcMicros < 1n) {
      return fail(res, 400, "Amount must be > 0");
    }
    if (!signature) return fail(res, 400, "Signature required");
    if (!timestamp || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      return fail(res, 400, "Timestamp expired");
    }

    const msg = `gasrun:withdraw:${address}:${usdcMicros.toString()}:${timestamp}`;
    if (!verifyMessage(address, msg, signature)) return fail(res, 401, "Invalid signature");

    const deployed = loadDeployed();
    if (!deployed.vault && !process.env.VAULT_ADDRESS && !process.env.CORE_ADDRESS) {
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

    const vBal = await vaultBalance();
    if (vBal < usdcMicros) {
      return fail(res, 503, "Vault underfunded — contact admin", {
        vaultBalance: usdcMicrosToDisplay(vBal),
      });
    }

    const ref = `wd-${address.slice(2, 10)}-${timestamp}-${usdcMicros.toString()}`;
    const reserved = await db`
      UPDATE users SET
        usdc_balance_micros = usdc_balance_micros - ${usdcMicros.toString()},
        updated_at = NOW()
      WHERE address = ${address} AND usdc_balance_micros >= ${usdcMicros.toString()}
      RETURNING *
    `;
    if (!reserved[0]) return fail(res, 400, "Insufficient balance (race)");

    await db`
      INSERT INTO withdrawals (address, usdc_micros, status, ref)
      VALUES (${address}, ${usdcMicros.toString()}, 'pending', ${ref})
    `;

    try {
      const { txHash, ref: refBytes } = await payoutUsdc(address, usdcMicros.toString(), ref);
      await db`
        UPDATE withdrawals SET status = 'completed', tx_hash = ${txHash}, completed_at = NOW()
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
      await db`
        UPDATE users SET
          usdc_balance_micros = usdc_balance_micros + ${usdcMicros.toString()},
          updated_at = NOW()
        WHERE address = ${address}
      `;
      await db`
        UPDATE withdrawals SET status = 'failed', error = ${String(txErr?.message || txErr)}
        WHERE ref = ${ref}
      `;
      return fail(res, 500, "On-chain payout failed: " + (txErr?.message || String(txErr)));
    }
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
