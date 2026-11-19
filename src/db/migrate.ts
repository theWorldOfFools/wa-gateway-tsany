import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';
import { createPool } from './index.js';
import { loadConfig } from '../config.js';

async function findMigrationsDir(): Promise<string> {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations')
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Migrations directory not found. Looked in: ${candidates.join(', ')}`
  );
}

export async function runMigrations(db: Db): Promise<string[]> {
  const dir = await findMigrationsDir();
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.sql')).sort();

  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const existing = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file]
      );
      if (existing.rowCount) continue;

      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, {
          cause: error
        });
      }
    }
  } finally {
    client.release();
  }

  return applied;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const config = loadConfig();
  const db = createPool(config);
  try {
    const applied = await runMigrations(db);
    console.log(
      applied.length ? `Applied migrations: ${applied.join(', ')}` : 'No pending migrations.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
