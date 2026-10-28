'use strict';

// Spotify Web API client for a single user: token refresh, a throttled and
// shared "now playing" lookup, track metadata and playback control.

const { config } = require('./config');

class SpotifyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class SpotifyClient {
  constructor(store) {
    this.store = store;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.refreshing = null;

    this.nowPlaying = null; // { data, fetchedAt }
    this.nowPlayingInflight = null;
    this.lastNowPlayingCallAt = 0;
    this.backoffUntil = 0;
    this.lastPlayed = null;

    // Recently seen track metadata, so lyrics lookups rarely need Spotify.
    this.trackMeta = new Map();
  }

  // ---- OAuth -------------------------------------------------------------

  authorizeUrl(state) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.spotify.clientId,
      scope: config.spotify.scopes.join(' '),
      redirect_uri: config.spotify.redirectUri,
      state,
    });
    return `${config.spotify.accountsUrl}/authorize?${params}`;
  }

  async tokenRequest(body) {
    const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64');
    const res = await fetch(`${config.spotify.accountsUrl}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SpotifyError(res.status, json.error || 'token_error', json.error_description || `Token request failed (${res.status})`);
    }
    return json;
  }

  async exchangeCode(code) {
    const json = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.spotify.redirectUri,
    });
    if (!json.refresh_token) throw new SpotifyError(502, 'no_refresh_token', 'Spotify did not return a refresh token');
    await this.store.setRefreshToken(json.refresh_token);
    this.setAccessToken(json);
  }

  setAccessToken(json) {
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  }

  async isConnected() {
    return Boolean(await this.store.getRefreshToken());
  }

  async getAccessToken(forceRefresh = false) {
    // Refresh a minute before expiry so requests never race the deadline.
    if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiresAt - 60000) {
      return this.accessToken;
    }
    if (!this.refreshing) {
      this.refreshing = this.refreshAccessToken().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async refreshAccessToken() {
    const refreshToken = await this.store.getRefreshToken();
    if (!refreshToken) {
      throw new SpotifyError(503, 'not_connected', 'Spotify is not connected yet. Visit /auth/login?key=ADMIN_KEY once.');
    }
    let json;
    try {
      json = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch (err) {
      if (err.code === 'invalid_grant') {
        // The user revoked access or the token was rotated elsewhere.
        await this.store.setRefreshToken(null);
        this.accessToken = null;
        throw new SpotifyError(503, 'not_connected', 'Spotify access was revoked. Log in again via /auth/login.');
      }
      throw err;
    }
    if (json.refresh_token && json.refresh_token !== refreshToken) {
      await this.store.setRefreshToken(json.refresh_token);
    }
    this.setAccessToken(json);
    return this.accessToken;
  }

  // ---- Web API -----------------------------------------------------------

  async api(method, path, { retried = false } = {}) {
    const token = await this.getAccessToken(retried);
    const res = await fetch(`${config.spotify.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401 && !retried) {
      return this.api(method, path, { retried: true });
    }
    if (res.status === 204) return { status: 204, body: null };

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      const err = new SpotifyError(429, 'rate_limited', 'Spotify rate limit hit');
      err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    if (!res.ok) {
      const e = (body && body.error) || {};
      const err = new SpotifyError(res.status, e.reason || 'spotify_error', e.message || `Spotify returned ${res.status}`);
      throw err;
    }
    return { status: res.status, body };
  }

  // ---- Now playing (throttled, shared by every client) -------------------

  async getNowPlaying() {
    const now = Date.now();
    const fresh = this.nowPlaying && now - this.lastNowPlayingCallAt < config.spotifyMinIntervalMs;
    if (fresh || (this.nowPlaying && now < this.backoffUntil)) {
      return this.project(this.nowPlaying, now);
    }
    if (!this.nowPlayingInflight) {
      this.nowPlayingInflight = this.fetchNowPlaying().finally(() => {
        this.nowPlayingInflight = null;
      });
    }
    try {
      const snapshot = await this.nowPlayingInflight;
      return this.project(snapshot, Date.now());
    } catch (err) {
      if (err.status === 429) {
        this.backoffUntil = Date.now() + err.retryAfterMs;
      }
      // Serve a recent snapshot rather than blanking the screen on a hiccup.
      if (this.nowPlaying && err.code !== 'not_connected' && Date.now() - this.nowPlaying.fetchedAt < 30000) {
        return this.project(this.nowPlaying, Date.now());
      }
      throw err;
    }
  }

  async fetchNowPlaying() {
    if (Date.now() < this.backoffUntil) {
      throw new SpotifyError(429, 'rate_limited', 'Waiting for Spotify rate limit to clear');
    }
    this.lastNowPlayingCallAt = Date.now();
    const sentAt = Date.now();
    const { status, body } = await this.api('GET', '/me/player/currently-playing?additional_types=track,episode');
    // Assume Spotify measured progress halfway through the round trip.
    const fetchedAt = Math.round((sentAt + Date.now()) / 2);
    const data = status === 204 || !body ? idleState() : normalise(body);

    if (data.trackId) {
      this.lastPlayed = { title: data.title, artists: data.artists, albumArtUrl: data.albumArtUrl };
      this.rememberTrack(data);
    }
    this.nowPlaying = { data, fetchedAt };
    return this.nowPlaying;
  }

  // Returns a copy with progress advanced to "now" for cached snapshots.
  project(snapshot, now) {
    const data = { ...snapshot.data };
    if (data.isPlaying && typeof data.progressMs === 'number') {
      const advanced = data.progressMs + (now - snapshot.fetchedAt);
      data.progressMs = data.durationMs ? Math.min(advanced, data.durationMs) : advanced;
    }
    data.serverTimestamp = now;
    data.lastPlayed = this.lastPlayed;
    return data;
  }

  // Called after a control action so the next poll sees the change sooner.
  invalidateNowPlaying(patch) {
    if (!this.nowPlaying) return;
    if (patch) {
      const now = Date.now();
      const current = this.project(this.nowPlaying, now);
      const data = { ...this.nowPlaying.data, progressMs: current.progressMs, ...patch };
      this.nowPlaying = { data, fetchedAt: now };
    }
    // Allow a fresh fetch about one second from now while keeping the 2s spacing loose.
    this.lastNowPlayingCallAt = Math.min(this.lastNowPlayingCallAt, Date.now() - config.spotifyMinIntervalMs + 1000);
  }

  rememberTrack(data) {
    this.trackMeta.set(data.trackId, {
      title: data.title,
      artists: data.artists,
      album: data.album,
      durationMs: data.durationMs,
      type: data.type,
    });
    if (this.trackMeta.size > 200) this.trackMeta.delete(this.trackMeta.keys().next().value);
  }

  async getTrackMeta(trackId) {
    if (this.trackMeta.has(trackId)) return this.trackMeta.get(trackId);
    const { body } = await this.api('GET', `/tracks/${encodeURIComponent(trackId)}`);
    const data = normalise({ currently_playing_type: 'track', item: body, is_playing: false, progress_ms: 0 });
    this.rememberTrack(data);
    return this.trackMeta.get(trackId);
  }

  async control(action, { positionMs } = {}) {
    const routes = {
      play: ['PUT', '/me/player/play', { isPlaying: true }],
      pause: ['PUT', '/me/player/pause', { isPlaying: false }],
      next: ['POST', '/me/player/next', null],
      previous: ['POST', '/me/player/previous', null],
    };
    if (action === 'seek') {
      const pos = Math.round(Number(positionMs));
      if (!Number.isFinite(pos) || pos < 0) throw new SpotifyError(400, 'bad_request', 'positionMs is required for seek');
      routes.seek = ['PUT', `/me/player/seek?position_ms=${pos}`, { progressMs: pos }];
    }
    const route = routes[action];
    if (!route) throw new SpotifyError(400, 'unknown_action', `Unknown action "${action}"`);
    try {
      await this.api(route[0], route[1]);
    } catch (err) {
      if (err.status === 403) {
        throw new SpotifyError(403, 'premium_required', 'Playback control needs Spotify Premium (or Spotify refused this action right now).');
      }
      if (err.status === 404) {
        throw new SpotifyError(404, 'no_active_device', 'No active Spotify device. Start playing on a device first.');
      }
      throw err;
    }
    this.invalidateNowPlaying(route[2]);
  }
}

function idleState() {
  return {
    isPlaying: false,
    type: 'none',
    trackId: null,
    title: null,
    artists: [],
    album: null,
    albumArtUrl: null,
    durationMs: 0,
    progressMs: 0,
  };
}

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  // Largest image that's still reasonable for a 400px slot (Spotify offers 640/300/64).
  const sorted = [...images].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0].url;
}

function normalise(body) {
  const type = body.currently_playing_type || (body.item && body.item.type) || 'unknown';
  const item = body.item;
  const base = {
    isPlaying: Boolean(body.is_playing),
    type,
    trackId: null,
    title: null,
    artists: [],
    album: null,
    albumArtUrl: null,
    durationMs: 0,
    progressMs: typeof body.progress_ms === 'number' ? body.progress_ms : 0,
  };

  if (type === 'ad') {
    return { ...base, title: 'Advertisement', artists: ['Spotify'] };
  }
  if (!item) {
    return { ...base, type: type === 'unknown' ? 'unknown' : type };
  }
  if (type === 'episode' || item.type === 'episode') {
    const show = item.show || {};
    return {
      ...base,
      type: 'episode',
      trackId: item.id,
      title: item.name,
      artists: [show.publisher || show.name].filter(Boolean),
      album: show.name || null,
      albumArtUrl: pickImage(item.images) || pickImage(show.images),
      durationMs: item.duration_ms || 0,
    };
  }
  return {
    ...base,
    type: 'track',
    trackId: item.id || (item.uri ? `local:${item.uri}` : null),
    title: item.name,
    artists: (item.artists || []).map((a) => a.name).filter(Boolean),
    album: item.album ? item.album.name : null,
    albumArtUrl: item.album ? pickImage(item.album.images) : null,
    durationMs: item.duration_ms || 0,
  };
}

module.exports = { SpotifyClient, SpotifyError, normalise };
