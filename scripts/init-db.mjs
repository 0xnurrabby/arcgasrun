import { neon } from "@neondatabase/serverless";

const url =
  process.env.DATABASE_URL ||
  "postgresql://neondb_owner:npg_uIjqyceN90YA@ep-solitary-paper-at24gjnq.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require";

const sql = neon(url);

async function main() {
  await sql`
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
  await sql`
    CREATE TABLE IF NOT EXISTS weekly_scores (
      id BIGSERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      points BIGINT NOT NULL,
      week_start_ms BIGINT NOT NULL,
      tx_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_week ON weekly_scores(week_start_ms)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_addr ON weekly_scores(address)`;
  await sql`
    CREATE TABLE IF NOT EXISTS conversions (
      id BIGSERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      points BIGINT NOT NULL,
      usdc_micros BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
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
  await sql`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      detail JSONB,
      actor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  console.log("Neon schema ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
