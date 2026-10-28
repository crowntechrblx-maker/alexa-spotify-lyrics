'use strict';

// End-to-end tests against fake Spotify and LRCLIB servers.
// Set TEST_DATABASE_URL to also run them against PostgreSQL.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakes } = require('../scripts/fakes');

const TOKEN = 'test-display-token-0123456789';
const ADMIN = 'test-admin-key-0123456789';

let fakes;
let base;
let server;
let store;
let spotify;

function memoryStore() {
  const lyrics = new Map();
  let refresh = null;
  return {
    kind: 'test',
    async init() {},
    async getRefreshToken() { return refresh; },
    async setRefreshToken(t) { refresh = t || null; },
    async getLyrics(id) { return lyrics.get(id) || null; },
    async setLyrics(id, status, payload) { lyrics.set(id, { status, payload, fetchedAt: Date.now() }); },
    async close() {},
  };
}

const api = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { 'X-Display-Token': TOKEN, ...(opts.headers || {}) } });

test.before(async () => {
  fakes = await startFakes(0);
  Object.assign(process.env, {
    SPOTIFY_CLIENT_ID: 'id',
    SPOTIFY_CLIENT_SECRET: 'secret',
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1/auth/callback',
    SPOTIFY_ACCOUNTS_URL: fakes.baseUrl,
    SPOTIFY_API_URL: `${fakes.baseUrl}/v1`,
    LRCLIB_URL: fakes.baseUrl,
    DISPLAY_TOKEN: TOKEN,
    ADMIN_KEY: ADMIN,
    SESSION_SECRET: 'test-session-secret-0123456789',
    DATABASE_URL: process.env.TEST_DATABASE_URL || '',
  });
  const { createApp } = require('../src/server');
  const { createStore } = require('../src/store');
  const { SpotifyClient } = require('../src/spotify');
  const { LyricsService } = require('../src/lyrics');

  if (process.env.TEST_DATABASE_URL) {
    store = createStore();
    await store.init();
    await store.pool.query('TRUNCATE spotify_auth, lyrics_cache');
  } else {
    store = memoryStore();
  }
  spotify = new SpotifyClient(store);
  const app = createApp({ store, spotify, lyrics: new LyricsService(store) });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await fakes.close();
  await store.close();
});

test('API rejects missing or wrong display token', async () => {
  assert.equal((await fetch(`${base}/api/now-playing`)).status, 401);
  assert.equal((await fetch(`${base}/api/now-playing?t=nope`)).status, 401);
});

test('reports not_connected before the first login', async () => {
  const res = await api('/api/now-playing');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_connected');
});

test('login requires the admin key', async () => {
  const res = await fetch(`${base}/auth/login?key=wrong`, { redirect: 'manual' });
  assert.equal(res.status, 403);
});

test('callback rejects a state that was not issued by /auth/login', async () => {
  const res = await fetch(`${base}/auth/callback?code=x&state=forged.1.sig`);
  assert.equal(res.status, 400);
  assert.equal(await store.getRefreshToken(), null);
});

test('full OAuth flow stores the refresh token', async () => {
  const login = await fetch(`${base}/auth/login?key=${ADMIN}`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('location'));
  assert.equal(authorize.searchParams.get('scope'), 'user-read-currently-playing user-read-playback-state user-modify-playback-state');
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // The fake Spotify bounces straight back to the redirect URI.
  const consent = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(consent.headers.get('location'));
  const res = await fetch(`${base}/auth/callback${callback.search}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Spotify connected/);
  assert.ok(html.includes(`/?t=${TOKEN}`));
  assert.equal(await store.getRefreshToken(), 'fake-refresh');
});

test('now-playing returns the normalised shape', async () => {
  const res = await api('/api/now-playing');
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const key of ['isPlaying', 'trackId', 'title', 'artists', 'album', 'albumArtUrl', 'durationMs', 'progressMs', 'serverTimestamp']) {
    assert.ok(key in body, `missing ${key}`);
  }
  assert.equal(body.trackId, 'demo1');
  assert.deepEqual(body.artists, ['The Placeholders']);
});

test('many concurrent polls make at most one Spotify call per 2 seconds', async () => {
  await new Promise((r) => setTimeout(r, 2100));
  const before = fakes.calls.nowPlaying;
  await Promise.all(Array.from({ length: 20 }, () => api('/api/now-playing').then((r) => r.json())));
  await api('/api/now-playing');
  assert.equal(fakes.calls.nowPlaying - before, 1);
});

test('cached snapshots advance progress while playing', async () => {
  const a = await (await api('/api/now-playing')).json();
  await new Promise((r) => setTimeout(r, 300));
  const b = await (await api('/api/now-playing')).json();
  assert.ok(b.progressMs - a.progressMs >= 250, `${a.progressMs} -> ${b.progressMs}`);
});

test('lyrics: synced lookup, then served from cache', async () => {
  const before = fakes.calls.lrclib;
  const first = await (await api('/api/lyrics?trackId=demo1')).json();
  assert.equal(first.status, 'synced');
  assert.equal(first.synced, true);
  assert.equal(first.cached, false);
  assert.equal(first.lines[0].text, 'Streetlights hum a quiet tune');
  assert.equal(first.lines[0].timeMs, 4000);
  const lrclibCalls = fakes.calls.lrclib - before;

  const second = await (await api('/api/lyrics?trackId=demo1')).json();
  assert.equal(second.cached, true);
  assert.equal(fakes.calls.lrclib - before, lrclibCalls);
});

test('lyrics: search fallback finds word-synced lyrics', async () => {
  const body = await (await api('/api/lyrics?trackId=demo2')).json();
  assert.equal(body.status, 'synced');
  assert.equal(body.wordSynced, true);
});

test('lyrics: plain-only and not-found are reported and cached', async () => {
  const plain = await (await api('/api/lyrics?trackId=demo3')).json();
  assert.equal(plain.status, 'plain');
  assert.equal(plain.synced, false);
  assert.ok(plain.plainLyrics.length > 10);

  const before = fakes.calls.lrclib;
  const none = await (await api('/api/lyrics?trackId=demo4')).json();
  assert.equal(none.status, 'none');
  const again = await (await api('/api/lyrics?trackId=demo4')).json();
  assert.equal(again.cached, true);
  assert.ok(fakes.calls.lrclib - before >= 1);
  assert.equal((await store.getLyrics('demo4')).status, 'none');
});

test('controls work and seek requires a position', async () => {
  let res = await api('/api/control/pause', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(fakes.player.playing, false);
  res = await api('/api/control/play', { method: 'POST' });
  assert.equal(fakes.player.playing, true);
  res = await api('/api/control/next', { method: 'POST' });
  assert.equal(res.status, 200);
  res = await api('/api/control/seek', { method: 'POST' });
  assert.equal(res.status, 400);
  res = await api('/api/control/seek?positionMs=5000', { method: 'POST' });
  assert.equal(res.status, 200);
  res = await api('/api/control/explode', { method: 'POST' });
  assert.equal(res.status, 400);
});

test('controls return a clear error without Premium', async () => {
  fakes.player.premium = false;
  const res = await api('/api/control/next', { method: 'POST' });
  fakes.player.premium = true;
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'premium_required');
  assert.match(body.message, /Premium/);
});

test('nothing playing (204) returns an idle state with the last track', async () => {
  fakes.player.active = false;
  await new Promise((r) => setTimeout(r, 2100));
  const body = await (await api('/api/now-playing')).json();
  fakes.player.active = true;
  assert.equal(body.isPlaying, false);
  assert.equal(body.trackId, null);
  assert.equal(body.type, 'none');
  assert.ok(body.lastPlayed && body.lastPlayed.albumArtUrl);
});

test('expired access tokens are refreshed automatically', async () => {
  const tokensBefore = fakes.calls.token;
  spotify.accessTokenExpiresAt = Date.now() + 30000; // inside the 60s refresh margin
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal((await api('/api/now-playing')).status, 200);
  assert.equal(fakes.calls.token, tokensBefore + 1);
});

test('a revoked refresh token reports not_connected', async () => {
  await store.setRefreshToken('revoked');
  spotify.accessToken = null;
  spotify.nowPlaying = null;
  await new Promise((r) => setTimeout(r, 2100));
  const res = await api('/api/now-playing');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_connected');
  assert.equal(await store.getRefreshToken(), null);
});

test('art proxy only fetches from Spotify CDNs', async () => {
  const res = await api(`/api/art?url=${encodeURIComponent('https://evil.example.com/x.png')}`);
  assert.equal(res.status, 400);
});

test('serves the display page with no-referrer policy', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await res.text(), /lyrics-panel/);
});

test('pairing: a screen gets the token only after approval with the token', async () => {
  const start = await (await fetch(`${base}/pair/start`, { method: 'POST' })).json();
  assert.match(start.code, /^\d{6}$/);
  assert.ok(start.id.length > 20);

  let status = await (await fetch(`${base}/pair/status?id=${start.id}`)).json();
  assert.deepEqual(status, { status: 'pending' });

  // Approving needs the display token.
  const anon = await fetch(`${base}/api/pair/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: start.code }),
  });
  assert.equal(anon.status, 401);

  const wrong = await api('/api/pair/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '12345' }),
  });
  assert.equal(wrong.status, 404);

  const ok = await api('/api/pair/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: start.code }),
  });
  assert.equal(ok.status, 200);

  status = await (await fetch(`${base}/pair/status?id=${start.id}`)).json();
  assert.deepEqual(status, { status: 'approved', token: TOKEN });
  // Handed out once only.
  status = await (await fetch(`${base}/pair/status?id=${start.id}`)).json();
  assert.equal(status.status, 'expired');
});

test('pairing: unknown ids are expired and the pair page is served', async () => {
  const status = await (await fetch(`${base}/pair/status?id=nope`)).json();
  assert.equal(status.status, 'expired');
  const page = await fetch(`${base}/pair`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Link a screen/);
});
