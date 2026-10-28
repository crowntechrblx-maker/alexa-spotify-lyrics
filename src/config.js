'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

const config = {
  port: Number(process.env.PORT) || 3000,

  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || '',
    // Overridable only so the test suite / demo can point at a fake Spotify.
    accountsUrl: trimSlash(process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com'),
    apiUrl: trimSlash(process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1'),
    scopes: ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state'],
  },

  lrclibUrl: trimSlash(process.env.LRCLIB_URL || 'https://lrclib.net'),

  // Optional: Spotify's own lyrics via your web-player login cookie (unofficial).
  spotifyWeb: {
    spDc: (process.env.SPOTIFY_SP_DC || '').trim(),
    webUrl: trimSlash(process.env.SPOTIFY_WEB_URL || 'https://open.spotify.com'),
    spclientUrl: trimSlash(process.env.SPOTIFY_SPCLIENT_URL || 'https://spclient.wg.spotify.com'),
    // Community-maintained list of the web player's rotating TOTP secrets (data only).
    secretsUrl:
      process.env.SPOTIFY_SECRETS_URL ||
      'https://raw.githubusercontent.com/Thereallo1026/spotify-secrets/refs/heads/main/secrets/secretDict.json',
  },

  databaseUrl: process.env.DATABASE_URL || '',
  // "true" / "false" to force; otherwise SSL is used for any non-local, fully qualified host.
  databaseSsl: process.env.DATABASE_SSL,

  sessionSecret: process.env.SESSION_SECRET || '',
  adminKey: process.env.ADMIN_KEY || '',
  displayToken: process.env.DISPLAY_TOKEN || '',

  // Minimum gap between calls to Spotify's "currently playing" endpoint.
  spotifyMinIntervalMs: 2000,
};

function validate() {
  const problems = [];
  const weak = (v) => !v || v.length < 16;
  if (!config.spotify.clientId) problems.push('SPOTIFY_CLIENT_ID is not set');
  if (!config.spotify.clientSecret) problems.push('SPOTIFY_CLIENT_SECRET is not set');
  if (!config.spotify.redirectUri) problems.push('SPOTIFY_REDIRECT_URI is not set');
  if (weak(config.sessionSecret)) problems.push('SESSION_SECRET should be at least 16 characters');
  if (weak(config.adminKey)) problems.push('ADMIN_KEY should be at least 16 characters');
  if (weak(config.displayToken)) problems.push('DISPLAY_TOKEN should be at least 16 characters');
  return problems;
}

module.exports = { config, validate };
