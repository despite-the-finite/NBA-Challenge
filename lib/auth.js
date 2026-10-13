// Sign-in for exactly two players: pick your name, enter your PIN. Sessions are signed cookies.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sql } from './db.js';

const COOKIE = 'nbac_session';
const DAYS = 180;

function secret() { const s = process.env.SESSION_SECRET; if (!s) throw new Error('SESSION_SECRET is not set'); return s; }
function sign(payload) { return createHmac('sha256', secret()).update(payload).digest('base64url'); }

export function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(pin), salt, 32).toString('hex') };
}
function pinMatches(pin, salt, hash) {
  if (!salt || !hash) return false;
  const a = Buffer.from(hashPin(pin, salt).hash, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

/** Returns the player code ('UP'|'KP') for a valid session cookie, else null. */
export function currentPlayer(req) {
  const tok = parseCookies(req)[COOKIE]; if (!tok) return null;
  const [code, exp, sig] = tok.split('.');
  if (!code || !exp || !sig) return null;
  if (sign(`${code}.${exp}`) !== sig) return null;
  if (Number(exp) < Date.now()) return null;
  return code === 'UP' || code === 'KP' ? code : null;
}

export function setSession(res, code) {
  const exp = Date.now() + DAYS * 86400e3;
  const tok = `${code}.${exp}.${sign(`${code}.${exp}`)}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

/** Verify a PIN with a lockout after 5 misses (15 minutes). Returns {ok, error}. */
export async function verifyPin(code, pin) {
  const rows = await sql()`select pin_hash, pin_salt, failed_pins, locked_until from players where code = ${code}`;
  const p = rows[0];
  if (!p) return { ok: false, error: 'Unknown player.' };
  if (p.locked_until && new Date(p.locked_until) > new Date()) return { ok: false, error: 'Too many wrong PINs. Try again in a few minutes.' };
  if (!p.pin_hash) return { ok: false, error: 'No PIN set for this player yet.' };
  if (!pinMatches(pin, p.pin_salt, p.pin_hash)) {
    const fails = (p.failed_pins || 0) + 1;
    await sql()`update players set failed_pins = ${fails}, locked_until = ${fails >= 5 ? new Date(Date.now() + 15 * 60e3).toISOString() : null} where code = ${code}`;
    return { ok: false, error: fails >= 5 ? 'Too many wrong PINs. Locked for 15 minutes.' : 'Wrong PIN.' };
  }
  await sql()`update players set failed_pins = 0, locked_until = null where code = ${code}`;
  return { ok: true };
}

export async function setPin(code, pin) {
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4 to 8 digits.');
  const { salt, hash } = hashPin(pin);
  await sql()`update players set pin_hash = ${hash}, pin_salt = ${salt}, failed_pins = 0, locked_until = null where code = ${code}`;
}

/** Small helpers for handlers. */
export function requirePlayer(req, res) {
  const me = currentPlayer(req);
  if (!me) { res.status(401).json({ error: 'Not signed in.' }); return null; }
  return me;
}
export function json(res, status, body) { res.status(status).json(body); }
