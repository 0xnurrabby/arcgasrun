const {
  ensureSchema,
  getSql,
  usdcMicrosToDisplay,
  USDC_MICROS_PER_UNIT,
} = require("../lib/db");
const {
  isAdminAddress,
  verifyMessage,
  parseJsonBody,
  ok,
  fail,
  cors,
  ADMIN,
} = require("../lib/auth");
const {
  vaultBalance,
  adminWithdrawUsdc,
  loadDeployed,
  getProvider,
  getUsdc,
  ARC_CHAIN_ID,
  ARC_RPC,
  USDC,
} = require("../lib/chain");

function checkAdminAuth(body) {
  const address = String(body.address || "").toLowerCase();
  const timestamp = Number(body.timestamp || 0);
  const signature = body.signature;
  if (!isAdminAddress(address)) return { ok: false, error: "Not admin wallet" };
  if (!signature) return { ok: false, error: "Signature required" };
  if (!timestamp || Math.abs(Date.now() - timestamp) > 30 * 60 * 1000) {
    return { ok: false, error: "Timestamp expired" };
  }
  const msg = `gasrun:admin:${address}:${timestamp}`;
  if (!verifyMessage(address, msg, signature)) {
    return { ok: false, error: "Invalid signature" };
  }
  return { ok: true, address };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    await ensureSchema();
    const db = getSql();
    const deployed = loadDeployed();

    // Public config (no auth) — admin UI needs addresses
    if (req.method === "GET" && String(req.query.public || "") === "1") {
      let vBal = "0";
      try {
        vBal = (await vaultBalance()).toString();
      } catch {}
      return ok(res, {
        admin: ADMIN,
        chainId: ARC_CHAIN_ID,
        rpc: ARC_RPC,
        usdc: deployed.usdc || USDC,
        vault: process.env.CORE_ADDRESS || process.env.VAULT_ADDRESS || deployed.core || deployed.vault || "",
        score: process.env.CORE_ADDRESS || process.env.SCORE_ADDRESS || deployed.core || deployed.score || "",
        core: process.env.CORE_ADDRESS || process.env.VAULT_ADDRESS || deployed.core || deployed.vault || "",
        operator: deployed.operator || "",
        vaultBalance: usdcMicrosToDisplay(vBal),
        vaultBalanceMicros: vBal,
      });
    }

    if (req.method === "GET") {
      // Overview requires admin address in query + optional skip sig for read if header? Require sig via query is hard.
      // Use POST for authenticated admin actions; GET overview with address only for soft check is insecure.
      // We'll accept GET with address matching admin for dashboard numbers (read-only public-ish stats).
      const address = String(req.query.address || "").toLowerCase();
      if (!isAdminAddress(address)) {
        return fail(res, 403, "Admin wallet required", { admin: ADMIN });
      }

      // Users = only wallets that did real activity (convert / withdraw / LB deposit)
      const usersCount = await db`
        SELECT COUNT(*)::int AS c FROM (
          SELECT address FROM conversions
          UNION
          SELECT address FROM withdrawals
          UNION
          SELECT address FROM weekly_scores
        ) active_users
      `;
      const totalUsdc = await db`
        SELECT COALESCE(SUM(usdc_balance_micros),0)::text AS s FROM users
        WHERE address IN (
          SELECT address FROM conversions
          UNION SELECT address FROM withdrawals
          UNION SELECT address FROM weekly_scores
        )
      `;
      const totalWithdrawn = await db`
        SELECT COALESCE(SUM(usdc_micros),0)::text AS s FROM withdrawals WHERE status = 'completed'
      `;
      const pendingWd = await db`
        SELECT COUNT(*)::int AS c FROM withdrawals WHERE status = 'pending'
      `;
      const weekScores = await db`
        SELECT COALESCE(SUM(points),0)::text AS s FROM weekly_scores
        WHERE week_start_ms = ${require("../lib/db").weekStartUtcMs()}
      `;
      const recentWd = await db`
        SELECT id, address, usdc_micros::text, status, tx_hash, ref, error, created_at
        FROM withdrawals ORDER BY id DESC LIMIT 50
      `;
      const recentConv = await db`
        SELECT id, address, points, usdc_micros::text, created_at
        FROM conversions ORDER BY id DESC LIMIT 50
      `;
      const topUsers = await db`
        SELECT u.address, u.bank_points, u.usdc_balance_micros::text, u.total_deposited_pts, u.created_at
        FROM users u
        WHERE u.address IN (
          SELECT address FROM conversions
          UNION SELECT address FROM withdrawals
          UNION SELECT address FROM weekly_scores
        )
        ORDER BY u.usdc_balance_micros DESC LIMIT 50
      `;
      const recentDeposits = await db`
        SELECT id, address, points, week_start_ms, tx_hash, created_at
        FROM weekly_scores ORDER BY id DESC LIMIT 50
      `;

      let vBal = "0";
      try {
        vBal = (await vaultBalance()).toString();
      } catch (e) {
        vBal = "error:" + (e?.message || e);
      }

      // First-seen day per active user (first convert OR withdraw OR LB deposit)
      const firstSeen = await db`
        SELECT address, MIN(day) AS day FROM (
          SELECT address, to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day FROM conversions
          UNION ALL
          SELECT address, to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day FROM withdrawals
          UNION ALL
          SELECT address, to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day FROM weekly_scores
        ) t GROUP BY address
      `;
      const byDayNew = {};
      for (const r of firstSeen) {
        byDayNew[r.day] = (byDayNew[r.day] || 0) + 1;
      }
      const sortedDays = Object.keys(byDayNew).sort();
      const userGrowth = sortedDays
        .filter((d) => d >= new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10))
        .map((day) => ({ day, new_users: byDayNew[day] }));

      const wdGrowth = await db`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count,
               COALESCE(SUM(usdc_micros),0)::text AS volume_micros
        FROM withdrawals
        WHERE status = 'completed' AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY 1 ORDER BY 1 ASC
      `;
      const actGrowth = await db`
        SELECT day, SUM(n)::int AS actions FROM (
          SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM conversions WHERE created_at > NOW() - INTERVAL '14 days' GROUP BY 1
          UNION ALL
          SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM weekly_scores WHERE created_at > NOW() - INTERVAL '14 days' GROUP BY 1
          UNION ALL
          SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n FROM withdrawals WHERE created_at > NOW() - INTERVAL '14 days' GROUP BY 1
        ) t GROUP BY day ORDER BY day ASC
      `;

      let cum = 0;
      const cumulativeUsers = sortedDays.map((day) => {
        cum += byDayNew[day] || 0;
        return { day, users: cum, newUsers: byDayNew[day] || 0 };
      }).slice(-14);

      const userGrowthMapped = userGrowth.map((r) => ({ day: r.day, newUsers: r.new_users }));

      return ok(res, {
        admin: ADMIN,
        chain: {
          chainId: ARC_CHAIN_ID,
          rpc: ARC_RPC,
          usdc: deployed.usdc || USDC,
          vault: process.env.CORE_ADDRESS || process.env.VAULT_ADDRESS || deployed.core || deployed.vault || "",
          score: process.env.CORE_ADDRESS || process.env.SCORE_ADDRESS || deployed.core || deployed.score || "",
          core: process.env.CORE_ADDRESS || process.env.VAULT_ADDRESS || deployed.core || deployed.vault || "",
          operator: deployed.operator || "",
        },
        stats: {
          users: usersCount[0]?.c || 0,
          userUsdcLiabilities: usdcMicrosToDisplay(totalUsdc[0]?.s || 0),
          totalWithdrawn: usdcMicrosToDisplay(totalWithdrawn[0]?.s || 0),
          pendingWithdrawals: pendingWd[0]?.c || 0,
          weekPoints: weekScores[0]?.s || "0",
          vaultBalance: typeof vBal === "string" && vBal.startsWith("error")
            ? vBal
            : usdcMicrosToDisplay(vBal),
          vaultBalanceMicros: typeof vBal === "string" && vBal.startsWith("error") ? "0" : vBal,
        },
        charts: {
          userGrowth: userGrowthMapped,
          cumulativeUsers,
          withdrawals: wdGrowth.map((r) => ({
            day: r.day,
            count: r.count,
            volume: usdcMicrosToDisplay(r.volume_micros),
          })),
          activity: actGrowth.map((r) => ({ day: r.day, actions: r.actions })),
        },
        recentWithdrawals: recentWd.map((r) => ({
          ...r,
          amount: usdcMicrosToDisplay(r.usdc_micros),
        })),
        recentConversions: recentConv.map((r) => ({
          ...r,
          amount: usdcMicrosToDisplay(r.usdc_micros),
        })),
        recentDeposits,
        topUsers: topUsers.map((u) => ({
          ...u,
          usdcBalance: usdcMicrosToDisplay(u.usdc_balance_micros),
        })),
      });
    }

    if (req.method === "POST") {
      const body = parseJsonBody(req);
      const auth = checkAdminAuth(body);
      if (!auth.ok) return fail(res, 403, auth.error);

      const action = String(body.action || "");

      if (action === "admin_withdraw") {
        const to = String(body.to || auth.address).toLowerCase();
        const amountUsdc = Number(body.amountUsdc || 0);
        const micros = BigInt(Math.floor(amountUsdc * USDC_MICROS_PER_UNIT));
        if (micros <= 0n) return fail(res, 400, "amountUsdc required");
        const result = await adminWithdrawUsdc(to, micros.toString());
        await db`
          INSERT INTO admin_logs (action, detail, actor)
          VALUES (
            'admin_withdraw',
            ${JSON.stringify({ to, amountUsdc, micros: micros.toString(), txHash: result.txHash })},
            ${auth.address}
          )
        `;
        return ok(res, { ...result, amount: usdcMicrosToDisplay(micros) });
      }

      if (action === "credit_usdc") {
        const to = String(body.to || "").toLowerCase();
        const amountUsdc = Number(body.amountUsdc || 0);
        const micros = BigInt(Math.floor(amountUsdc * USDC_MICROS_PER_UNIT));
        if (!/^0x[a-f0-9]{40}$/.test(to)) return fail(res, 400, "Invalid to");
        if (micros <= 0n) return fail(res, 400, "amountUsdc required");
        await db`
          INSERT INTO users (address, usdc_balance_micros)
          VALUES (${to}, ${micros.toString()})
          ON CONFLICT (address) DO UPDATE SET
            usdc_balance_micros = users.usdc_balance_micros + EXCLUDED.usdc_balance_micros,
            updated_at = NOW()
        `;
        await db`
          INSERT INTO admin_logs (action, detail, actor)
          VALUES (
            'credit_usdc',
            ${JSON.stringify({ to, amountUsdc, micros: micros.toString() })},
            ${auth.address}
          )
        `;
        return ok(res, { credited: usdcMicrosToDisplay(micros), to });
      }

      if (action === "set_user_usdc") {
        const to = String(body.to || "").toLowerCase();
        const amountUsdc = Number(body.amountUsdc || 0);
        const micros = BigInt(Math.floor(amountUsdc * USDC_MICROS_PER_UNIT));
        if (!/^0x[a-f0-9]{40}$/.test(to)) return fail(res, 400, "Invalid to");
        await db`
          INSERT INTO users (address, usdc_balance_micros)
          VALUES (${to}, ${micros.toString()})
          ON CONFLICT (address) DO UPDATE SET
            usdc_balance_micros = ${micros.toString()},
            updated_at = NOW()
        `;
        await db`
          INSERT INTO admin_logs (action, detail, actor)
          VALUES (
            'set_user_usdc',
            ${JSON.stringify({ to, amountUsdc, micros: micros.toString() })},
            ${auth.address}
          )
        `;
        return ok(res, { set: usdcMicrosToDisplay(micros), to });
      }

      if (action === "logs") {
        const logs = await db`
          SELECT id, action, detail, actor, created_at
          FROM admin_logs ORDER BY id DESC LIMIT 100
        `;
        return ok(res, { logs });
      }

      return fail(res, 400, "Unknown action");
    }

    return fail(res, 405, "Method not allowed");
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
