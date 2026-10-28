'use strict';

// Optional fallback: Spotify's own lyrics (the ones shown in the Spotify app),
// fetched the way the web player does it, using your sp_dc login cookie.
// This is an unofficial, undocumented Spotify endpoint; it can change or
// break at any time. Enabled only when SPOTIFY_SP_DC is set.

const crypto = require('crypto');
const { config } = require('./config');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class SpotifyLyricsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30s) for a given unix time in seconds.
function totp(key, timeSec) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeSec / 30)));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(bin).padStart(6, '0');
}

// The web player derives its TOTP key from a published byte list.
function keyFromCipher(bytes) {
  const joined = bytes.map((b, i) => b ^ ((i % 33) + 9)).join('');
  return Buffer.from(joined, 'utf8');
}

// Accepts { "61": [..], "60": [..] } or [{ version, secret }, ...]; returns the newest.
function pickSecret(data) {
  const entries = Array.isArray(data)
    ? data.map((d) => [Number(d.version), d.secret])
    : Object.keys(data || {}).map((k) => [Number(k), data[k]]);
  const valid = entries.filter(([v, s]) => Number.isFinite(v) && Array.isArray(s) && s.length);
  if (!valid.length) return null;
  valid.sort((a, b) => b[0] - a[0]);
  return { version: valid[0][0], bytes: valid[0][1] };
}

class SpotifyLyrics {
  constructor() {
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.secret = null;
  }

  get enabled() {
    return Boolean(config.spotifyWeb.spDc);
  }

  async getSecret(force) {
    if (this.secret && !force) return this.secret;
    const res = await fetch(config.spotifyWeb.secretsUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new SpotifyLyricsError('secrets_unavailable', `Could not load web player secrets (${res.status})`);
    const secret = pickSecret(await res.json());
    if (!secret) throw new SpotifyLyricsError('secrets_unavailable', 'Web player secrets list was empty or unreadable');
    this.secret = secret;
    return secret;
  }

  async fetchToken(retried = false) {
    const headers = { Cookie: `sp_dc=${config.spotifyWeb.spDc}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' };
    const base = config.spotifyWeb.webUrl;

    let serverTime = Math.floor(Date.now() / 1000);
    try {
      const st = await fetch(`${base}/api/server-time`, { headers, signal: AbortSignal.timeout(8000) });
      if (st.ok) serverTime = Number((await st.json()).serverTime) || serverTime;
    } catch {
      /* fall back to our own clock */
    }

    const secret = await this.getSecret(retried);
    const key = keyFromCipher(secret.bytes);
    const params = new URLSearchParams({
      reason: 'init',
      productType: 'web-player',
      totp: totp(key, Math.floor(Date.now() / 1000)),
      totpServer: totp(key, serverTime),
      totpVer: String(secret.version),
    });
    const res = await fetch(`${base}/api/token?${params}`, { headers, signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || !body.accessToken) {
      // Secrets rotate; reload them once before giving up.
      if (!retried) return this.fetchToken(true);
      throw new SpotifyLyricsError('token_failed', `Spotify web token request failed (${res.status})`);
    }
    if (body.isAnonymous) {
      throw new SpotifyLyricsError('bad_cookie', 'The sp_dc cookie was not accepted (expired or copied incorrectly).');
    }
    this.token = body.accessToken;
    this.tokenExpiresAt = Number(body.accessTokenExpirationTimestampMs) || Date.now() + 30 * 60 * 1000;
    return this.token;
  }

  async getToken(force) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  // Returns a LRCLIB-shaped record ({ syncedLyrics?, lines?, plainLyrics }) or null if Spotify has none.
  async get(trackId, retried = false) {
    if (!this.enabled || !/^[A-Za-z0-9]{22}$/.test(trackId)) return null;
    const token = await this.getToken(retried);
    const url = `${config.spotifyWeb.spclientUrl}/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'App-Platform': 'WebPlayer', 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return null;
    if (res.status === 401 && !retried) return this.get(trackId, true);
    if (!res.ok) throw new SpotifyLyricsError('lyrics_failed', `Spotify lyrics request failed (${res.status})`);

    const lyrics = ((await res.json().catch(() => ({}))) || {}).lyrics;
    if (!lyrics || !Array.isArray(lyrics.lines) || !lyrics.lines.length) return null;

    const lines = lyrics.lines.map((l) => {
      const text = String(l.words || '').trim();
      return { timeMs: Number(l.startTimeMs) || 0, text: text === '♪' ? '' : text };
    });
    const plainLyrics = lines.map((l) => l.text).join('\n');
    if (lyrics.syncType === 'UNSYNCED' || lines.every((l) => l.timeMs === 0)) {
      return { plainLyrics, provider: lyrics.provider };
    }
    return { lines, plainLyrics, provider: lyrics.provider };
  }

  // For the /auth/check page.
  async selfTest() {
    if (!this.enabled) return { ok: false, message: 'SPOTIFY_SP_DC is not set, so Spotify lyrics are off.' };
    try {
      await this.getToken(true);
      return { ok: true, message: 'The sp_dc cookie works. Spotify lyrics are on.' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }
}

module.exports = { SpotifyLyrics, totp, keyFromCipher, pickSecret };
