import "dotenv/config";
import pg from "pg";

// BIGINT/NUMERIC come back as strings by default — parse the ones we use as numbers.
pg.types.setTypeParser(20, (v) => Number(v)); // int8 (count(*))
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

const connectionString = process.env.DATABASE_URL ?? "postgresql://wolven:wolven@localhost:5432/wolvenwear";

export const pool = new pg.Pool({
  connectionString,
  // most hosted Postgres (Neon, Supabase, Render) require SSL
  ssl: /sslmode=require|neon\.tech|supabase\.co|render\.com/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export const query = <T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => pool.query<T>(text, params);

/** Run a function inside a transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
