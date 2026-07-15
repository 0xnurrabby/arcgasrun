const { neon } = require("@neondatabase/serverless");

let sql = null;
let ready = null;

function getSql() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sql = neon(url);
  }
  return sql;
}

async function ensureSchema() {
  if (ready) return ready;
  ready = (async () => {
    const db = getSql();
    await db`
      CREATE TABLE IF NOT EXISTS users (
        address TEXT PRIMARY KEY,
        bank_points BIGINT NOT NULL DEFAULT 0,
        usdc_balance_micros BIGINT NOT NULL DEFAULT 0,
        total_deposited_pts BIGINT NOT NULL DEFAULT 0,
        coins BIGINT NOT NULL DEFAULT 0,
        last_decay_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS weekly_scores (
        id BIGSERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        points BIGINT NOT NULL,
        week_start_ms BIGINT NOT NULL,
        tx_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await db`CREATE INDEX IF NOT EXISTS idx_weekly_week ON weekly_scores(week_start_ms)`;
    await db`CREATE INDEX IF NOT EXISTS idx_weekly_addr ON weekly_scores(address)`;
    await db`
      CREATE TABLE IF NOT EXISTS conversions (
        id BIGSERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        points BIGINT NOT NULL,
        usdc_micros BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id BIGSERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        usdc_micros BIGINT NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ref TEXT UNIQUE,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id BIGSERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        detail JSONB,
        actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await db`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    return true;
  })();
  return ready;
}

function normAddr(a) {
  return String(a || "").toLowerCase();
}

function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  const diffToMon = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0);
}

// 1000 points = 1 USDC = 1_000_000 micros
const POINTS_PER_USDC = 1000;
const USDC_DECIMALS = 6;
const USDC_MICROS_PER_UNIT = 10 ** USDC_DECIMALS;
const MIN_WITHDRAW_MICROS = 1; // no practical min — any positive amount

function pointsToUsdcMicros(points) {
  const p = BigInt(Math.floor(Number(points) || 0));
  return p * BigInt(USDC_MICROS_PER_UNIT) / BigInt(POINTS_PER_USDC);
}

function usdcMicrosToDisplay(micros) {
  const m = BigInt(micros || 0);
  const whole = m / BigInt(USDC_MICROS_PER_UNIT);
  const frac = (m % BigInt(USDC_MICROS_PER_UNIT)).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** Read-only: never creates a user row (balance checks must not pollute admin stats) */
async function getUser(address) {
  const db = getSql();
  const addr = normAddr(address);
  const rows = await db`SELECT * FROM users WHERE address = ${addr}`;
  return rows[0] || null;
}

/**
 * Create user only on real activity (convert / withdraw / leaderboard deposit).
 * Do NOT call from GET balance endpoints.
 */
async function getOrCreateUser(address) {
  const db = getSql();
  const addr = normAddr(address);
  const rows = await db`SELECT * FROM users WHERE address = ${addr}`;
  if (rows[0]) return rows[0];
  const created = await db`
    INSERT INTO users (address) VALUES (${addr})
    ON CONFLICT (address) DO NOTHING
    RETURNING *
  `;
  if (created[0]) return created[0];
  const again = await db`SELECT * FROM users WHERE address = ${addr}`;
  return again[0];
}

module.exports = {
  getSql,
  ensureSchema,
  normAddr,
  weekStartUtcMs,
  POINTS_PER_USDC,
  USDC_MICROS_PER_UNIT,
  MIN_WITHDRAW_MICROS,
  pointsToUsdcMicros,
  usdcMicrosToDisplay,
  getUser,
  getOrCreateUser,
};
