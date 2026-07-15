// Neon-backed weekly leaderboard for Arc GasRun
const {
  ensureSchema,
  getSql,
  weekStartUtcMs,
  normAddr,
} = require("./lib/db");
const { ok, fail, cors } = require("./lib/auth");

const MAX_TOP = 100;

async function fetchNamesFromNeynar(addresses) {
  const key = process.env.NEYNAR_API_KEY;
  if (!key) return new Map();
  const uniq = [...new Set((addresses || []).map((a) => String(a || "").toLowerCase()))].filter(Boolean);
  if (!uniq.length) return new Map();
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk-by-address");
    url.searchParams.set("addresses", chunk.join(","));
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json", api_key: key },
    });
    if (!res.ok) continue;
    const json = await res.json();
    for (const u of json?.users || []) {
      const addr = (u?.verified_addresses?.eth_addresses?.[0] || "").toLowerCase();
      if (addr && u?.username) out.set(addr, u.username);
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    await ensureSchema();
    const db = getSql();
    const includeNames = String(req.query.names || "0") === "1";
    const addressRaw = String(req.query.address || "").trim();
    const viewerAddress = /^0x[a-fA-F0-9]{40}$/.test(addressRaw) ? normAddr(addressRaw) : null;

    const curWeekMs = weekStartUtcMs();
    const prevWeekMs = curWeekMs - 7 * 24 * 60 * 60 * 1000;

    const weeklyRows = await db`
      SELECT address, SUM(points)::text AS points
      FROM weekly_scores
      WHERE week_start_ms = ${curWeekMs}
      GROUP BY address
      ORDER BY SUM(points) DESC
      LIMIT ${MAX_TOP}
    `;
    const lastWeekRows = await db`
      SELECT address, SUM(points)::text AS points
      FROM weekly_scores
      WHERE week_start_ms = ${prevWeekMs}
      GROUP BY address
      ORDER BY SUM(points) DESC
      LIMIT ${MAX_TOP}
    `;

    // full ranks for viewer
    let you = null;
    if (viewerAddress) {
      const w = await db`
        SELECT SUM(points)::text AS points FROM weekly_scores
        WHERE week_start_ms = ${curWeekMs} AND address = ${viewerAddress}
      `;
      const lw = await db`
        SELECT SUM(points)::text AS points FROM weekly_scores
        WHERE week_start_ms = ${prevWeekMs} AND address = ${viewerAddress}
      `;
      const wPts = w[0]?.points || "0";
      const lwPts = lw[0]?.points || "0";

      const wRank = await db`
        SELECT COUNT(*)::int AS c FROM (
          SELECT address FROM weekly_scores WHERE week_start_ms = ${curWeekMs}
          GROUP BY address HAVING SUM(points) > ${wPts}::bigint
        ) t
      `;
      const lwRank = await db`
        SELECT COUNT(*)::int AS c FROM (
          SELECT address FROM weekly_scores WHERE week_start_ms = ${prevWeekMs}
          GROUP BY address HAVING SUM(points) > ${lwPts}::bigint
        ) t
      `;

      you = {
        address: viewerAddress,
        weekly: {
          rank: Number(wPts) > 0 ? (wRank[0]?.c || 0) + 1 : null,
          points: wPts,
        },
        lastWeek: {
          rank: Number(lwPts) > 0 ? (lwRank[0]?.c || 0) + 1 : null,
          points: lwPts,
        },
      };
    }

    let weekly = weeklyRows.map((r) => ({ address: r.address, points: r.points }));
    let lastWeek = lastWeekRows.map((r) => ({ address: r.address, points: r.points }));

    if (includeNames) {
      const addrs = [...weekly, ...lastWeek].map((x) => x.address);
      const fcMap = await fetchNamesFromNeynar(addrs);
      weekly = weekly.map((it) => {
        const u = fcMap.get(it.address.toLowerCase());
        return { ...it, name: u ? `${u}.farcaster.eth` : undefined };
      });
      lastWeek = lastWeek.map((it) => {
        const u = fcMap.get(it.address.toLowerCase());
        return { ...it, name: u ? `${u}.farcaster.eth` : undefined };
      });
    }

    const counts = await db`
      SELECT
        (SELECT COUNT(DISTINCT address) FROM weekly_scores WHERE week_start_ms = ${curWeekMs})::int AS weekly_players,
        (SELECT COUNT(DISTINCT address) FROM weekly_scores WHERE week_start_ms = ${prevWeekMs})::int AS last_week_players
    `;

    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    const isoDay = (ms) => iso(ms).slice(0, 10);

    return ok(res, {
      weekStart: curWeekMs,
      prevWeekStart: prevWeekMs,
      windows: {
        current: {
          startMs: curWeekMs,
          endMs: curWeekMs + ONE_WEEK,
          startISO: iso(curWeekMs),
          endISO: iso(curWeekMs + ONE_WEEK),
          label: `${isoDay(curWeekMs)} (UTC)`,
        },
        previous: {
          startMs: prevWeekMs,
          endMs: prevWeekMs + ONE_WEEK,
          startISO: iso(prevWeekMs),
          endISO: iso(prevWeekMs + ONE_WEEK),
          label: `${isoDay(prevWeekMs)} (UTC)`,
        },
      },
      weekly,
      lastWeek,
      you: you || undefined,
      meta: {
        updatedAt: Date.now(),
        counts: {
          weeklyPlayers: counts[0]?.weekly_players || 0,
          lastWeekPlayers: counts[0]?.last_week_players || 0,
        },
        source: "neon",
      },
    });
  } catch (e) {
    return fail(res, 500, e?.message || String(e));
  }
};
