'use strict';

// Persistence for the Spotify refresh token and the lyrics cache.
// Uses PostgreSQL when DATABASE_URL is set, otherwise an in-memory store
// (the refresh token is also written to .data/ so local restarts don't
// require logging in again).

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spotify_auth (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lyrics_cache (
  track_id   TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function wantsSsl(url) {
  if (config.databaseSsl === 'true') return true;
  if (config.databaseSsl === 'false') return false;
  try {
    const { hostname, searchParams } = new URL(url);
    if (searchParams.get('sslmode') === 'disable') return false;
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return false;
    // Render's internal hostnames (e.g. "dpg-abc123-a") have no dots and no SSL.
    return hostname.includes('.');
  } catch {
    return false;
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    this.kind = 'postgres';
    this.pool = new Pool({
      connectionString: url,
      ssl: wantsSsl(url) ? { rejectUnauthorized: false } : false,
      max: 4,
    });
    this.pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }

  async init() {
    await this.pool.query(SCHEMA);
  }

  async getRefreshToken() {
    const { rows } = await this.pool.query('SELECT refresh_token FROM spotify_auth WHERE id = 1');
    return rows[0] ? rows[0].refresh_token : null;
  }

  async setRefreshToken(token) {
    if (!token) {
      await this.pool.query('DELETE FROM spotify_auth WHERE id = 1');
      return;
    }
    await this.pool.query(
      `INSERT INTO spotify_auth (id, refresh_token, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
      [token]
    );
  }

  async getLyrics(trackId) {
    const { rows } = await this.pool.query(
      'SELECT status, payload, fetched_at FROM lyrics_cache WHERE track_id = $1',
      [trackId]
    );
    if (!rows[0]) return null;
    return { status: rows[0].status, payload: rows[0].payload, fetchedAt: new Date(rows[0].fetched_at).getTime() };
  }

  async setLyrics(trackId, status, payload) {
    await this.pool.query(
      `INSERT INTO lyrics_cache (track_id, status, payload, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (track_id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, fetched_at = now()`,
      [trackId, status, JSON.stringify(payload)]
    );
  }

  async close() {
    await this.pool.end();
  }
}

const LYRICS_MEMORY_LIMIT = 500;

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.lyrics = new Map();
    this.tokenFile = path.join(__dirname, '..', '.data', 'refresh-token.json');
    this.refreshToken = null;
  }

  async init() {
    try {
      this.refreshToken = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).refreshToken || null;
    } catch {
      this.refreshToken = null;
    }
  }

  async getRefreshToken() {
    return this.refreshToken;
  }

  async setRefreshToken(token) {
    this.refreshToken = token || null;
    try {
      fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
      fs.writeFileSync(this.tokenFile, JSON.stringify({ refreshToken: this.refreshToken }), { mode: 0o600 });
    } catch (err) {
      console.warn('[store] could not persist refresh token locally:', err.message);
    }
  }

  async getLyrics(trackId) {
    return this.lyrics.get(trackId) || null;
  }

  async setLyrics(trackId, status, payload) {
    // Map keeps insertion order, so re-inserting moves the entry to the end.
    this.lyrics.delete(trackId);
    this.lyrics.set(trackId, { status, payload, fetchedAt: Date.now() });
    if (this.lyrics.size > LYRICS_MEMORY_LIMIT) {
      this.lyrics.delete(this.lyrics.keys().next().value);
    }
  }

  async close() {}
}

function createStore() {
  return config.databaseUrl ? new PgStore(config.databaseUrl) : new MemoryStore();
}

module.exports = { createStore };
