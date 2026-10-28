'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLrc } = require('../src/lrc');
const { cleanTitle, bestSearchResult, buildPayload } = require('../src/lyrics');

test('parses basic LRC lines and skips metadata', () => {
  const lines = parseLrc('[ar:Someone]\n[ti:Song]\n[00:01.50] Hello\n[00:03.2]World\n\n[01:02.345] Later');
  assert.deepEqual(lines, [
    { timeMs: 1500, text: 'Hello' },
    { timeMs: 3200, text: 'World' },
    { timeMs: 62345, text: 'Later' },
  ]);
});

test('expands repeated timestamps and sorts', () => {
  const lines = parseLrc('[00:10.00][00:30.00] Chorus\n[00:20.00] Verse');
  assert.deepEqual(lines.map((l) => [l.timeMs, l.text]), [[10000, 'Chorus'], [20000, 'Verse'], [30000, 'Chorus']]);
});

test('keeps empty lines as gaps and applies the offset tag', () => {
  const lines = parseLrc('[offset:+500]\n[00:02.00] A\n[00:05.00]\n');
  assert.deepEqual(lines, [{ timeMs: 1500, text: 'A' }, { timeMs: 4500, text: '' }]);
});

test('parses enhanced LRC word timings', () => {
  const [line] = parseLrc('[00:01.00] <00:01.00>Hello <00:01.60>big <00:02.10>world');
  assert.equal(line.text, 'Hello big world');
  assert.deepEqual(line.words, [
    { timeMs: 1000, text: 'Hello' },
    { timeMs: 1600, text: 'big' },
    { timeMs: 2100, text: 'world' },
  ]);
});

test('returns [] for empty input', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc(null), []);
});

test('cleanTitle strips remaster and feature suffixes', () => {
  assert.equal(cleanTitle('Song - Remastered 2011'), 'Song');
  assert.equal(cleanTitle('Song (feat. Someone)'), 'Song');
  assert.equal(cleanTitle('Plain Song'), 'Plain Song');
});

test('bestSearchResult prefers synced lyrics within the duration tolerance', () => {
  const results = [
    { duration: 200, plainLyrics: 'x' },
    { duration: 260, syncedLyrics: '[00:01.00] wrong length' },
    { duration: 201, syncedLyrics: '[00:01.00] right' },
  ];
  assert.equal(bestSearchResult(results, 200), results[2]);
  assert.equal(bestSearchResult([], 200), null);
});

test('buildPayload reports plain-only and missing lyrics', () => {
  const plain = buildPayload('t1', { plainLyrics: 'la la' });
  assert.equal(plain.status, 'plain');
  assert.equal(plain.synced, false);
  assert.equal(plain.plainLyrics, 'la la');
  assert.match(plain.message, /plain/);

  const none = buildPayload('t2', null);
  assert.equal(none.status, 'none');
  assert.deepEqual(none.lines, []);
});
