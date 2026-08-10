/**
 * Applies every .sql file in db/ in filename order, tracking what has run in a
 * migrations table. Files are expected to be idempotent (if not exists / on
 * conflict do nothing) so a partial run can be repeated safely.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.ts';

const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

async function main() {
  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ filename: string }>('select filename from schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = (await readdir(dbDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`- ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(dbDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`✓ ${file}`);
    } catch (error) {
      await client.query('rollback');
      console.error(`✗ ${file}`);
      throw error;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('migrations complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
