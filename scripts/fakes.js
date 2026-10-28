'use strict';

// Tiny stand-ins for Spotify (accounts + Web API) and LRCLIB, used by
// `npm run demo` and the test suite. Lyrics here are original placeholder
// text written for this project.

const http = require('http');

const SYNCED_LINES = [
  [4.0, 'Streetlights hum a quiet tune'],
  [8.2, 'Painting puddles silver blue'],
  [12.5, 'Every window holds a little moon'],
  [16.8, "And I'm walking home to you"],
  [21.0, ''],
  [30.0, 'Neon harbour, carry me along'],
  [34.3, 'Through the static and the song'],
  [38.6, 'Every wave remembers where we belong'],
  [43.0, 'Neon harbour, carry me along'],
  [48.0, 'Hold the light until the morning comes'],
  [53.0, 'Hum it softly, hum it low'],
  [58.0, "Let the city's tide come and go"],
];

function lrcTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}

const syncedLrc = SYNCED_LINES.map(([t, text]) => `[${lrcTime(t)}] ${text}`).join('\n');

// Enhanced LRC with per-word timings.
const WORD_LINES = [
  [3.0, [['Paper', 0], ['planes', 0.5], ['across', 1.0], ['the', 1.6], ['sky', 1.8]]],
  [7.0, [['Folded', 0], ['wishes', 0.7], ['passing', 1.4], ['by', 2.2]]],
  [11.0, [['Catch', 0], ['one', 0.4], ['if', 0.8], ['you', 1.1], ['can', 1.4]]],
  [15.0, [['Hold', 0], ['it', 0.6], ['like', 0.9], ['a', 1.3], ['promise', 1.5]]],
  [19.5, [['Paper', 0], ['planes,', 0.5], ['paper', 1.3], ['planes', 1.9]]],
  [24.0, [['Fly', 0], ['me', 0.8], ['home', 1.6], ['again', 2.6]]],
];
const wordLrc = WORD_LINES.map(
  ([t, words]) => `[${lrcTime(t)}] ` + words.map(([w, d]) => `<${lrcTime(t + d)}>${w}`).join(' ')
).join('\n');

const PLAIN = `This one only has plain lyrics
So the page scrolls them slowly
In step with how far through the song you are

Second verse, same idea
Nothing here is timed
But it still moves along with the music

And then it ends`;

const TRACKS = [
  { id: 'demo1', title: 'Neon Harbour', artist: 'The Placeholders', album: 'Night Shift', durationMs: 64000, colors: ['#ff4f7b', '#5b2bd9', '#ffb347'], lyrics: { syncedLyrics: syncedLrc, plainLyrics: SYNCED_LINES.map((l) => l[1]).join('\n') } },
  { id: 'demo2', title: 'Paper Planes (Remastered 2020)', artist: 'Kite Club', album: 'Origami', durationMs: 30000, colors: ['#2bd9b4', '#1e5bd6', '#d6f04a'], lyrics: { syncedLyrics: wordLrc, plainLyrics: '' }, searchOnly: true },
  { id: 'demo3', title: 'Slow Scroll', artist: 'Plain Text', album: 'Unsynced', durationMs: 45000, colors: ['#e8833a', '#6e2b12', '#f3d27a'], lyrics: { syncedLyrics: null, plainLyrics: PLAIN } },
  { id: 'demo4', title: 'Wordless', artist: 'Instrumental Ensemble', album: 'Ambient', durationMs: 25000, colors: ['#3a8ee8', '#0c1d3d', '#9ad0ff'], lyrics: null },
];

function artSvg(track) {
  const [a, b, c] = track.colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="640" height="640" fill="url(#g)"/><circle cx="430" cy="230" r="150" fill="${c}" opacity="0.85"/>
<circle cx="200" cy="450" r="110" fill="${b}" opacity="0.7"/>
<text x="40" y="600" font-family="Helvetica,Arial,sans-serif" font-size="44" font-weight="700" fill="#fff" opacity="0.9">${track.album}</text></svg>`;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function startFakes(port = 0, opts = {}) {
  const player = {
    index: 0,
    playing: true,
    startedAt: Date.now() - (opts.startProgressMs || 0),
    pausedAt: 0,
    premium: opts.premium !== false,
    active: true,
  };
  const calls = { nowPlaying: 0, token: 0, lrclib: 0 };
  let baseUrl = '';

  function progress() {
    const t = TRACKS[player.index];
    const p = (player.playing ? Date.now() : player.pausedAt) - player.startedAt;
    if (p >= t.durationMs) {
      // Auto-advance like a real queue.
      player.index = (player.index + 1) % TRACKS.length;
      player.startedAt = Date.now();
      return progress();
    }
    return p;
  }

  function item(t) {
    return {
      id: t.id,
      type: 'track',
      name: t.title,
      duration_ms: t.durationMs,
      artists: [{ name: t.artist }],
      album: { name: t.album, images: [{ url: `${baseUrl}/art/${t.id}.svg`, width: 640, height: 640 }] },
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // ---- accounts ----
    if (p === '/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', 'fake-code');
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: redirect.toString() });
      return res.end();
    }
    if (p === '/api/token' && req.method === 'POST') {
      calls.token++;
      const body = new URLSearchParams(await readBody(req));
      if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'revoked') {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      }
      return json(res, 200, { access_token: `access-${calls.token}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh' });
    }

    // ---- art ----
    const art = p.match(/^\/art\/(\w+)\.svg$/);
    if (art) {
      const t = TRACKS.find((x) => x.id === art[1]);
      res.writeHead(t ? 200 : 404, { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' });
      return res.end(t ? artSvg(t) : '');
    }

    // ---- LRCLIB ----
    if (p === '/api/get' || p === '/api/search') {
      calls.lrclib++;
      const name = (url.searchParams.get('track_name') || '').toLowerCase();
      const matches = TRACKS.filter((t) => t.lyrics && (t.title.toLowerCase() === name || t.title.toLowerCase().startsWith(name + ' ')));
      const toRecord = (t) => ({ id: 1, trackName: t.title, artistName: t.artist, albumName: t.album, duration: t.durationMs / 1000, instrumental: false, ...t.lyrics });
      if (p === '/api/get') {
        const t = matches.find((x) => !x.searchOnly && x.title.toLowerCase() === name);
        return t ? json(res, 200, toRecord(t)) : json(res, 404, { code: 404, name: 'TrackNotFound' });
      }
      return json(res, 200, matches.map(toRecord));
    }

    // ---- Web API ----
    if (!/^Bearer access-/.test(req.headers.authorization || '')) {
      return json(res, 401, { error: { status: 401, message: 'Invalid access token' } });
    }
    if (p === '/v1/me/player/currently-playing') {
      calls.nowPlaying++;
      if (!player.active) {
        res.writeHead(204);
        return res.end();
      }
      const pr = progress();
      return json(res, 200, { is_playing: player.playing, progress_ms: pr, currently_playing_type: 'track', item: item(TRACKS[player.index]), timestamp: Date.now() });
    }
    const track = p.match(/^\/v1\/tracks\/(\w+)$/);
    if (track) {
      const t = TRACKS.find((x) => x.id === track[1]);
      return t ? json(res, 200, item(t)) : json(res, 404, { error: { status: 404, message: 'Not found' } });
    }
    const ctl = p.match(/^\/v1\/me\/player\/(play|pause|next|previous|seek)$/);
    if (ctl) {
      if (!player.premium) return json(res, 403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
      const action = ctl[1];
      const pr = progress();
      if (action === 'pause' && player.playing) {
        player.playing = false;
        player.pausedAt = Date.now();
      } else if (action === 'play' && !player.playing) {
        player.playing = true;
        player.startedAt = Date.now() - pr;
      } else if (action === 'next' || action === 'previous') {
        player.index = (player.index + (action === 'next' ? 1 : TRACKS.length - 1)) % TRACKS.length;
        player.startedAt = Date.now();
        player.pausedAt = Date.now();
      } else if (action === 'seek') {
        const pos = Number(url.searchParams.get('position_ms')) || 0;
        player.startedAt = (player.playing ? Date.now() : player.pausedAt) - pos;
      }
      res.writeHead(204);
      return res.end();
    }
    json(res, 404, { error: { status: 404, message: 'Not found' } });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, baseUrl, player, calls, tracks: TRACKS, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startFakes, TRACKS };
