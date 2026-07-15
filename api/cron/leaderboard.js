// Optional cron: warm Neon-backed leaderboard (no-op heavy work; ensures schema)
const { ensureSchema, weekStartUtcMs, getSql } = require("../lib/db");

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const db = getSql();
    const week = weekStartUtcMs();
    const rows = await db`
      SELECT COUNT(DISTINCT address)::int AS c FROM weekly_scores WHERE week_start_ms = ${week}
    `;
    res.status(200).json({ ok: true, weekStart: week, players: rows[0]?.c || 0 });
  } catch (e) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
};
