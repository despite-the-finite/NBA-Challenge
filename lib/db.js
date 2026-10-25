// Neon Postgres over HTTP (works in Vercel serverless functions without connection pooling).
import { neon } from '@neondatabase/serverless';

let _sql;
export function sql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}
/** Test hook: swap the query function (tools/test_api.mjs uses an in-memory stub). */
export function _setSql(fn) { _sql = fn; _migrated = null; }

let _migrated = null;
/** Additive schema changes made after the first deploy (mirrored in db/schema.sql), applied once per
 *  instance so a redeploy never needs a manual migration. */
export function migrate() {
  if (!_migrated) {
    _migrated = (async () => {
      await sql()`alter table games add column if not exists cup_stage text`;
      await sql()`create table if not exists cup_picks (player_code text primary key references players(code), picks jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now())`;
    })().catch(e => { _migrated = null; throw e; });
  }
  return _migrated;
}
