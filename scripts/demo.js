'use strict';

// `npm run demo` — runs the display against a fake Spotify and fake LRCLIB so
// you can see the page without any credentials. Nothing touches your real
// Spotify account or saved token.

const { startFakes } = require('./fakes');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = 'demo-display-token-1234';

(async () => {
  const fakes = await startFakes(0);

  Object.assign(process.env, {
    SPOTIFY_CLIENT_ID: 'demo',
    SPOTIFY_CLIENT_SECRET: 'demo',
    SPOTIFY_REDIRECT_URI: `http://127.0.0.1:${PORT}/auth/callback`,
    SPOTIFY_ACCOUNTS_URL: fakes.baseUrl,
    SPOTIFY_API_URL: `${fakes.baseUrl}/v1`,
    LRCLIB_URL: fakes.baseUrl,
    DISPLAY_TOKEN: TOKEN,
    ADMIN_KEY: 'demo-admin-key-123456',
    SESSION_SECRET: 'demo-session-secret-123456',
    DATABASE_URL: '',
  });

  const { createApp } = require('../src/server');
  const { SpotifyClient } = require('../src/spotify');
  const { LyricsService } = require('../src/lyrics');

  // In-memory store that is already "logged in".
  const lyricsCache = new Map();
  const store = {
    kind: 'demo',
    async getRefreshToken() { return 'fake-refresh'; },
    async setRefreshToken() {},
    async getLyrics(id) { return lyricsCache.get(id) || null; },
    async setLyrics(id, status, payload) { lyricsCache.set(id, { status, payload, fetchedAt: Date.now() }); },
    async close() {},
  };

  const app = createApp({ store, spotify: new SpotifyClient(store), lyrics: new LyricsService(store) });
  app.listen(PORT, () => {
    console.log(`Demo running: http://127.0.0.1:${PORT}/?t=${TOKEN}`);
    console.log('Tap/click the album art for controls. Ctrl+C to stop.');
  });
})();
