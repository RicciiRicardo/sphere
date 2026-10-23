import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

// Production uses Postgres (Neon) via DATABASE_URL. Without it, an embedded
// Postgres (PGlite) stores data in ./.data so the app runs locally with no setup.
function connect(): Db {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
    return {
      query: async <T>(sql: string, params?: unknown[]) => {
        const res = await pool.query(sql, params);
        return { rows: res.rows as T[] };
      },
      exec: async (sql) => {
        await pool.query(sql);
      },
    };
  }
  mkdirSync(".data", { recursive: true });
  const lite = new PGlite(".data/pglite");
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await lite.query<T>(sql, params);
      return { rows: res.rows };
    },
    exec: async (sql) => {
      await lite.exec(sql);
    },
  };
}

export const db = connect();

export async function migrate() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      role_card TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      is_chair BOOLEAN NOT NULL DEFAULT FALSE,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      turn_id TEXT NOT NULL,
      speaker TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at);

    CREATE TABLE IF NOT EXISTS memory (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
