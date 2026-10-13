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
export function _setSql(fn) { _sql = fn; }
