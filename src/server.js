'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { config, validate } = require('./config');
const { createStore } = require('./store');
const { SpotifyClient } = require('./spotify');
const { LyricsService } = require('./lyrics');

const ART_HOSTS = /(^|\.)(scdn\.co|spotifycdn\.com)$/i;
const STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:640px;margin:10vh auto;padding:0 20px;line-height:1.5}a{color:#1ed760;word-break:break-all}code{background:#222;padding:2px 6px;border-radius:4px}</style>
</head><body>${body}</body></html>`;
}

function sendError(res, err) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500 && err.code !== 'not_connected') console.error('[api]', err.message);
  res.status(status).json({ error: err.code || 'server_error', message: err.message || 'Something went wrong' });
}

function createApp({ store, spotify, lyrics }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    // Keep the display token out of Referer headers sent to image CDNs.
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, store: store.kind });
  });

  // ---- Spotify login (one time, by the owner) -----------------------------

  app.get('/auth/login', (req, res) => {
    if (!config.adminKey || !safeEqual(String(req.query.key || ''), config.adminKey)) {
      return res.status(403).send(page('Forbidden', '<h1>Forbidden</h1><p>Add <code>?key=YOUR_ADMIN_KEY</code> to the URL.</p>'));
    }
    if (!config.spotify.clientId || !config.spotify.redirectUri || !config.sessionSecret) {
      return res.status(500).send(page('Not configured', '<h1>Not configured</h1><p>Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI and SESSION_SECRET first.</p>'));
    }
    const nonce = `${crypto.randomBytes(16).toString('base64url')}.${Date.now()}`;
    const state = `${nonce}.${sign(nonce)}`;
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: STATE_MAX_AGE_MS,
      path: '/auth',
    });
    res.redirect(spotify.authorizeUrl(state));
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).send(page('Login cancelled', `<h1>Spotify login failed</h1><p>${escapeHtml(error)}</p>`));
    }
    const cookieState = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/auth' });

    const parts = String(state || '').split('.');
    const nonce = parts.slice(0, 2).join('.');
    const issuedAt = Number(parts[1]);
    const valid =
      parts.length === 3 &&
      safeEqual(String(state), cookieState) &&
      safeEqual(parts[2], sign(nonce)) &&
      Date.now() - issuedAt < STATE_MAX_AGE_MS;
    if (!valid || !code) {
      return res.status(400).send(page('Invalid login', '<h1>Login link expired or invalid</h1><p>Start again from <code>/auth/login?key=…</code> in the same browser.</p>'));
    }

    try {
      await spotify.exchangeCode(String(code));
    } catch (err) {
      console.error('[auth] code exchange failed:', err.message);
      return res.status(502).send(page('Login failed', `<h1>Could not finish Spotify login</h1><p>${escapeHtml(err.message)}</p>`));
    }

    const displayUrl = `${req.protocol}://${req.get('host')}/?t=${encodeURIComponent(config.displayToken)}`;
    res.send(
      page(
        'Spotify connected',
        `<h1>✅ Spotify connected</h1><p>The refresh token is saved (${escapeHtml(store.kind)} store). You won't need to log in again.</p>
<p>Your display URL (bookmark this on the Echo Show):</p><p><a href="${escapeHtml(displayUrl)}">${escapeHtml(displayUrl)}</a></p>`
      )
    );
  });

  // ---- API (protected by the display token) -------------------------------

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!config.displayToken) {
      return res.status(503).json({ error: 'not_configured', message: 'DISPLAY_TOKEN is not set on the server.' });
    }
    const token = req.get('x-display-token') || req.query.t;
    if (!safeEqual(String(token || ''), config.displayToken)) {
      return res.status(401).json({ error: 'bad_token', message: 'Missing or invalid display token.' });
    }
    next();
  });

  api.get('/now-playing', async (req, res) => {
    try {
      res.json(await spotify.getNowPlaying());
    } catch (err) {
      sendError(res, err);
    }
  });

  api.get('/lyrics', async (req, res) => {
    const trackId = String(req.query.trackId || '').trim();
    if (!trackId || trackId.length > 200) {
      return res.status(400).json({ error: 'bad_request', message: 'trackId is required' });
    }
    try {
      const payload = await lyrics.get(trackId, () => spotify.getTrackMeta(trackId));
      res.json(payload);
    } catch (err) {
      if (!err.code && !err.status) {
        console.error('[lyrics]', err.message);
        return res.status(502).json({ error: 'lyrics_unavailable', message: 'Lyrics service is unavailable right now.' });
      }
      sendError(res, err);
    }
  });

  api.post('/control/:action', async (req, res) => {
    try {
      await spotify.control(req.params.action, { positionMs: req.query.positionMs });
      res.json({ ok: true, action: req.params.action });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Same-origin copy of the album art so the page can read its pixels for
  // colour extraction even if the CDN doesn't send CORS headers.
  api.get('/art', async (req, res) => {
    let url;
    try {
      url = new URL(String(req.query.url || ''));
    } catch {
      return res.status(400).end();
    }
    if (url.protocol !== 'https:' || !ART_HOSTS.test(url.hostname)) return res.status(400).end();
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.ok || !type.startsWith('image/')) return res.status(502).end();
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > 3 * 1024 * 1024) return res.status(502).end();
      res.set('Content-Type', type);
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    } catch {
      res.status(502).end();
    }
  });

  app.use('/api', api);

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: 'index.html',
      setHeaders(res, file) {
        if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      },
    })
  );

  return app;
}

async function main() {
  for (const problem of validate()) console.warn(`[config] ${problem}`);

  const store = createStore();
  await store.init();
  const spotify = new SpotifyClient(store);
  const lyrics = new LyricsService(store);
  const app = createApp({ store, spotify, lyrics });

  const server = app.listen(config.port, () => {
    console.log(`Lyrics display listening on http://localhost:${config.port} (store: ${store.kind})`);
  });

  const shutdown = () => {
    server.close(() => store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
