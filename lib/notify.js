// Web push via VAPID. Subscriptions live in push_subscriptions; dead ones are pruned on 404/410.
import webpush from 'web-push';
import { sql } from './db.js';

let keys = null;
/** VAPID keys: env vars if set, else a pair generated once and kept in settings. */
export async function vapidKeys() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return (keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY });
  const [row] = await sql()`select vapid_public, vapid_private from settings where id = 1`;
  if (row?.vapid_public && row?.vapid_private) return (keys = { publicKey: row.vapid_public, privateKey: row.vapid_private });
  const fresh = webpush.generateVAPIDKeys();
  const [saved] = await sql()`update settings set vapid_public = coalesce(vapid_public, ${fresh.publicKey}), vapid_private = coalesce(vapid_private, ${fresh.privateKey}) where id = 1 returning vapid_public, vapid_private`;
  return (keys = { publicKey: saved.vapid_public, privateKey: saved.vapid_private });
}
async function configure() {
  const k = await vapidKeys();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:nba-challenge@example.com', k.publicKey, k.privateKey);
  return true;
}

/** Send to every device of a player. payload: {title, body, tag?, url?}. Returns devices reached. */
export async function sendTo(player, payload) {
  await configure();
  const subs = await sql()`select endpoint, p256dh, auth from push_subscriptions where player_code = ${player}`;
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 }); sent++; }
    catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await sql()`delete from push_subscriptions where endpoint = ${s.endpoint}`;
      else console.error('push failed', e?.statusCode, e?.body || e?.message);
    }
  }
  return sent;
}

/** Record a notification key; false if it was already sent. */
export async function once(key) {
  const rows = await sql()`insert into notifications_log (key) values (${key}) on conflict do nothing returning key`;
  return rows.length > 0;
}
