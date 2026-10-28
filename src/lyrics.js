'use strict';

// Looks up lyrics on LRCLIB and caches the result (including misses).

const { config } = require('./config');
const { parseLrc } = require('./lrc');

const USER_AGENT = 'alexa-spotify-lyrics/1.0 (self-hosted now-playing display)';
const NOT_FOUND_TTL_MS = 3 * 24 * 60 * 60 * 1000; // re-check misses after 3 days
const DURATION_TOLERANCE_S = 4;

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
  const artist = meta.artists[0] || '';
  const durationS = meta.durationMs ? Math.round(meta.durationMs / 1000) : 0;

  let record = null;
  if (meta.title && artist && meta.album && durationS) {
    record = await lrclib('/api/get', {
      track_name: meta.title,
      artist_name: artist,
      album_name: meta.album,
      duration: String(durationS),
    });
  }
  if (classify(record) === 'synced') return record;

  // Fall back to a search; try the cleaned-up title if the exact one fails.
  const titles = [...new Set([meta.title, cleanTitle(meta.title)])].filter(Boolean);
  for (const title of titles) {
    const params = { track_name: title };
    if (artist) params.artist_name = artist;
    const candidate = bestSearchResult(await lrclib('/api/search', params), durationS);
    if (RANK[classify(candidate)] > RANK[classify(record)]) record = candidate;
    if (classify(record) === 'synced') break;
  }
  return record;
}

function buildPayload(trackId, record) {
  const status = classify(record);
  const lines = status === 'synced' ? parseLrc(record.syncedLyrics) : [];
  return {
    trackId,
    status,
    synced: status === 'synced',
    lines,
    wordSynced: lines.some((l) => Array.isArray(l.words)),
    plainLyrics: status === 'synced' || status === 'plain' ? (record.plainLyrics || '').trim() || null : null,
    message: MESSAGES[status],
    source: record ? 'lrclib' : null,
  };
}

class LyricsService {
  constructor(store) {
    this.store = store;
    this.inflight = new Map();
  }

  async get(trackId, resolveMeta) {
    const cached = await this.store.getLyrics(trackId);
    if (cached && !(cached.status === 'none' && Date.now() - cached.fetchedAt > NOT_FOUND_TTL_MS)) {
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
        const payload = buildPayload(trackId, await findRecord(meta));
        await this.store.setLyrics(trackId, payload.status, payload);
        return payload;
      })().finally(() => this.inflight.delete(trackId));
      this.inflight.set(trackId, job);
    }
    return { ...(await this.inflight.get(trackId)), cached: false };
  }
}

module.exports = { LyricsService, cleanTitle, bestSearchResult, buildPayload };
