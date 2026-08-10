import pg from 'pg';

// Amounts are numeric(12,2); node-postgres hands those back as strings to avoid
// float precision loss. Everything downstream expects numbers, and euro amounts
// are nowhere near the safe-integer ceiling, so parse them here once.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
// bigserial ids also arrive as strings. Row counts here will never approach
// 2^53, so returning them as numbers keeps the JSON shape consistent.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// date columns should stay calendar dates, not shift by timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

export const pool = new pg.Pool({
  connectionString,
  // Railway's managed Postgres presents a self-signed cert on the public proxy.
  ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString)
    ? undefined
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
