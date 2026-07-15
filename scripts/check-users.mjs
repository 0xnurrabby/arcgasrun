import { neon } from "@neondatabase/serverless";

const sql = neon(
  process.env.DATABASE_URL ||
    "postgresql://neondb_owner:npg_uIjqyceN90YA@ep-solitary-paper-at24gjnq.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require"
);

const users = await sql`
  SELECT address, usdc_balance_micros::text AS usdc, total_deposited_pts, bank_points
  FROM users
  ORDER BY usdc_balance_micros DESC NULLS LAST
  LIMIT 20
`;
console.log("users", users);

const withdrawals = await sql`
  SELECT id, address, usdc_micros::text, status, error, created_at
  FROM withdrawals
  ORDER BY id DESC
  LIMIT 10
`;
console.log("withdrawals", withdrawals);
