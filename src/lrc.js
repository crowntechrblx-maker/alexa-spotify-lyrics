'use strict';

// Parses LRC text ("[01:23.45] some words") into [{ timeMs, text, words? }].
// Handles multiple timestamps per line, 1-3 digit fractions, metadata tags,
// the [offset:±ms] tag and enhanced LRC word timings ("<01:23.45>word"),
// which are returned as words: [{ timeMs, text }].

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]/i;

function toMs(min, sec, frac) {
  return Number(min) * 60000 + Number(sec) * 1000 + (frac ? Number(frac.padEnd(3, '0')) : 0);
}

// "<00:01.00>Hello <00:01.50>world" -> [{ timeMs: 1000, text: 'Hello' }, { timeMs: 1500, text: 'world' }]
function parseWords(body) {
  const words = [];
  WORD_TAG.lastIndex = 0;
  const tags = [];
  let m;
  while ((m = WORD_TAG.exec(body)) !== null) {
    tags.push({ timeMs: toMs(m[1], m[2], m[3]), start: m.index, end: WORD_TAG.lastIndex });
  }
  if (!tags.length) return null;
  tags.forEach((tag, i) => {
    const text = body.slice(tag.end, i + 1 < tags.length ? tags[i + 1].start : body.length).trim();
    if (text) words.push({ timeMs: tag.timeMs, text });
  });
  return words.length ? words : null;
}

function parseLrc(lrc) {
  if (!lrc || typeof lrc !== 'string') return [];

  let offsetMs = 0;
  const lines = [];

  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const offset = line.match(OFFSET_TAG);
    if (offset) {
      offsetMs = Number(offset[1]);
      continue;
    }

    const times = [];
    let lastIndex = 0;
    TIME_TAG.lastIndex = 0;
    let m;
    while ((m = TIME_TAG.exec(line)) !== null) {
      // Timestamps must be contiguous at the start of the line.
      if (m.index !== lastIndex) break;
      times.push(toMs(m[1], m[2], m[3]));
      lastIndex = TIME_TAG.lastIndex;
    }
    if (!times.length) continue; // metadata such as [ar:...] or junk

    const body = line.slice(lastIndex);
    const words = parseWords(body);
    const text = body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    for (const t of times) {
      const entry = { timeMs: t, text };
      // Word timings only make sense for the line's first occurrence.
      if (words && t === times[0]) entry.words = words;
      lines.push(entry);
    }
  }

  // LRC's offset tag: positive values make lyrics appear sooner.
  const shift = (t) => Math.max(0, t - offsetMs);
  return lines
    .map((l) => {
      const out = { timeMs: shift(l.timeMs), text: l.text };
      if (l.words) out.words = l.words.map((w) => ({ timeMs: shift(w.timeMs), text: w.text }));
      return out;
    })
    .sort((a, b) => a.timeMs - b.timeMs);
}

module.exports = { parseLrc };
