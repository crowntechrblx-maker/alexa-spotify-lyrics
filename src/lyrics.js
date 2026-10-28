'use strict';

// Looks up lyrics on LRCLIB and caches the result (including misses).

const { config } = require('./config');
const { parseLrc } = require('./lrc');

const USER_AGENT = 'alexa-spotify-lyrics/1.0 (self-hosted now-playing display)';
const NOT_FOUND_TTL_MS = 3 * 24 * 60 * 60 * 1000; // re-check misses after 3 days
const DURATION_TOLERANCE_S = 4;
const MAX_LOOKUPS = 8; // LRCLIB requests per track, at most
// Bump when the matching logic improves so cached misses get another try.
const LOOKUP_VERSION = 2;

const MESSAGES = {
  synced: 'Synced lyrics',
  plain: 'Only plain (unsynced) lyrics are available for this track.',
  instrumental: 'This track is instrumental.',
  none: 'No lyrics found for this track.',
};

// "Song - Remastered 2011" / "Song (feat. X)" -> "Song"
function cleanTitle(title) {
  return title
    .replace(/\s*[([].*?(feat\.|ft\.|with |remaster|live|version|edit|mono|stereo|demo|mix).*?[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|live|version|edit|mono|stereo|demo|mix|recorded|from ).*$/i, '')
    .trim();
}

// "Beyoncé & JAY-Z" -> "beyonce and jay z"
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0400-\uffff]+/g, ' ')
    .trim();
}

// Just the core title: "Song (Live at X) - 2011 Remaster" -> "Song"
function baseTitle(title) {
  return title.split(/\s+-\s+|\s*[([]/)[0].trim();
}

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
}

async function lrclib(path, params) {
  const url = `${config.lrclibUrl}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${path} returned ${res.status}`);
  return res.json();
}

function classify(record) {
  if (!record) return 'none';
  if (record.syncedLyrics && record.syncedLyrics.trim()) return 'synced';
  if (Array.isArray(record.lines) && record.lines.length) return 'synced';
  if (record.plainLyrics && record.plainLyrics.trim()) return 'plain';
  if (record.instrumental) return 'instrumental';
  return 'none';
}

const RANK = { synced: 3, plain: 2, instrumental: 1, none: 0 };

function bestSearchResult(results, durationS) {
  if (!Array.isArray(results)) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const diff = durationS && r.duration ? Math.abs(r.duration - durationS) : 0;
    if (durationS && r.duration && diff > DURATION_TOLERANCE_S) continue;
    const score = RANK[classify(r)] * 10 - diff;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

async function findRecord(meta) {
  const artists = (meta.artists || []).filter(Boolean);
  const artist = artists[0] || '';
  const durationS = meta.durationMs ? Math.round(meta.durationMs / 1000) : 0;
  const titles = [...new Set([meta.title, cleanTitle(meta.title), baseTitle(meta.title)])].filter(Boolean);
  const core = titles[titles.length - 1];

  let record = null;
  let lookups = 0;
  const tried = new Set();
  const consider = (candidate) => {
    if (RANK[classify(candidate)] > RANK[classify(record)]) record = candidate;
    return classify(record) === 'synced';
  };
  // Results from loose searches must still look like the right song.
  const plausible = (r) =>
    artists.some((a) => similar(a, r.artistName)) && titles.some((t) => similar(baseTitle(t), baseTitle(r.trackName || '')));

  async function search(params, loose) {
    const key = JSON.stringify(params);
    if (tried.has(key) || lookups >= MAX_LOOKUPS) return false;
    tried.add(key);
    lookups++;
    let results = await lrclib('/api/search', params);
    if (loose && Array.isArray(results)) results = results.filter(plausible);
    return consider(bestSearchResult(results, durationS));
  }

  // 1. Exact match on title, artist, album and duration.
  if (meta.title && artist && meta.album && durationS) {
    lookups++;
    if (consider(await lrclib('/api/get', {
      track_name: meta.title,
      artist_name: artist,
      album_name: meta.album,
      duration: String(durationS),
    }))) return record;
  }

  // 2. Search by title + main artist, trying simpler forms of the title.
  for (const title of titles) {
    if (await search(artist ? { track_name: title, artist_name: artist } : { track_name: title }, false)) return record;
  }

  // 3. Free-text search, then the other credited artists, then title only.
  if (artist && (await search({ q: `${core} ${artist}` }, true))) return record;
  for (const other of artists.slice(1, 3)) {
    if (await search({ track_name: core, artist_name: other }, false)) return record;
  }
  await search({ track_name: core }, true);
  return record;
}

function buildPayload(trackId, record, source = 'lrclib') {
  const status = classify(record);
  let lines = [];
  if (status === 'synced') lines = record.lines || parseLrc(record.syncedLyrics);
  return {
    trackId,
    status,
    synced: status === 'synced',
    lines,
    wordSynced: lines.some((l) => Array.isArray(l.words)),
    plainLyrics: status === 'synced' || status === 'plain' ? (record.plainLyrics || '').trim() || null : null,
    message: MESSAGES[status],
    source: record ? source : null,
  };
}

// Misses (and plain-only results) are retried after a while, or right away
// if they were found with older, weaker matching.
function isStale(cached, version) {
  if (cached.status !== 'none' && cached.status !== 'plain') return false;
  if ((cached.payload && cached.payload.lookupVersion) !== version) return true;
  return Date.now() - cached.fetchedAt > NOT_FOUND_TTL_MS;
}

class LyricsService {
  constructor(store, spotifyLyrics = null) {
    this.store = store;
    this.spotifyLyrics = spotifyLyrics;
    this.inflight = new Map();
  }

  // Changes when matching improves or Spotify lyrics get switched on, so old misses are retried.
  get version() {
    return this.spotifyLyrics && this.spotifyLyrics.enabled ? `${LOOKUP_VERSION}+spotify` : LOOKUP_VERSION;
  }

  // LRCLIB first; Spotify's own lyrics only when LRCLIB has no synced version.
  async lookup(trackId, meta) {
    const record = await findRecord(meta);
    let payload = buildPayload(trackId, record, 'lrclib');
    let retryable = false;
    if (payload.status !== 'synced' && this.spotifyLyrics && this.spotifyLyrics.enabled) {
      try {
        const sp = await this.spotifyLyrics.get(trackId);
        if (sp && RANK[classify(sp)] > RANK[payload.status]) payload = buildPayload(trackId, sp, 'spotify');
      } catch (err) {
        console.warn('[lyrics] Spotify lyrics fallback failed:', err.message);
        retryable = true;
      }
    }
    payload.lookupVersion = this.version;
    return { payload, retryable };
  }

  async get(trackId, resolveMeta) {
    const cached = await this.store.getLyrics(trackId);
    if (cached && !isStale(cached, this.version)) {
      return { ...cached.payload, cached: true };
    }
    // Several clients asking for the same track share one lookup.
    if (!this.inflight.has(trackId)) {
      const job = (async () => {
        const meta = await resolveMeta();
        if (!meta || !meta.title) throw Object.assign(new Error('Unknown track'), { status: 404 });
        if (meta.type === 'episode') {
          return { trackId, status: 'none', synced: false, lines: [], plainLyrics: null, message: 'Podcasts do not have lyrics.', source: null };
        }
        const { payload, retryable } = await this.lookup(trackId, meta);
        // Don't remember a miss caused by a temporary Spotify error.
        if (!(retryable && payload.status !== 'synced')) {
          await this.store.setLyrics(trackId, payload.status, payload);
        }
        return payload;
      })().finally(() => this.inflight.delete(trackId));
      this.inflight.set(trackId, job);
    }
    return { ...(await this.inflight.get(trackId)), cached: false };
  }
}

module.exports = { LyricsService, cleanTitle, baseTitle, norm, bestSearchResult, buildPayload };
