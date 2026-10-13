// App configuration. API is the Vercel serverless API path. The app falls back to demo mode
// (saved in this browser only) when the API is unreachable or when opened with ?demo=1.
window.NBA_CONFIG = {
  SEASON: '2026-27',
  API: '/api',
  PLAYERS: {
    UP: { name: 'UP', color: '#4f8cff' },
    KP: { name: 'KP', color: '#ff7a1a' },
  },
};
