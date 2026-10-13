// Web push via VAPID. Subscriptions live in push_subscriptions; dead ones are pruned on 404/410.
import webpush from 'web-push';
import { sql } from './db.js';

let configured = false;
function configure() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
  return (configured = true);
}

/** Send to every device of a player. payload: {title, body, tag?, url?}. Returns devices reached. */
export async function sendTo(player, payload) {
  if (!configure()) { console.warn('VAPID keys not set; push skipped'); return 0; }
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
