// App configuration. Leave SUPABASE_URL empty to run in demo mode (everything saved in this
// browser only). Fill in your Supabase project values to go live for both players.
window.NBA_CONFIG = {
  SEASON: '2026-27',
  SUPABASE_URL: '',          // e.g. 'https://abcdefghijklm.supabase.co'
  SUPABASE_ANON_KEY: '',     // Project Settings -> API -> anon public key
  VAPID_PUBLIC_KEY: '',      // from `npx web-push generate-vapid-keys`
  PLAYERS: {
    UP: { name: 'UP', color: '#4f8cff' },
    KP: { name: 'KP', color: '#ff7a1a' },
  },
};
