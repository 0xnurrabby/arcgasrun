import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL || "postgresql://neondb_owner:npg_uIjqyceN90YA@ep-solitary-paper-at24gjnq.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require");
await sql`TRUNCATE TABLE withdrawals, conversions, weekly_scores, admin_logs, users RESTART IDENTITY CASCADE`;
console.log("DB reset OK");
const c = await sql`SELECT count(*)::int AS n FROM users`;
console.log("users", c);
