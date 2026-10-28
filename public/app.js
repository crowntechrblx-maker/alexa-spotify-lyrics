/*
 * Now Playing lyrics display.
 * Plain ES2017 (no optional chaining etc.) so older Silk builds can run it.
 */
(function () {
  'use strict';

  // ---------- Settings ----------

  var POLL_MS = 3000;
  var LYRIC_LEAD_MS = 0;            // base lead; per-device tweak via the Earlier/Later buttons
  var ACTIVE_LINE_POSITION = 0.4;   // active line sits 40% down the lyrics panel
  var IDLE_AFTER_PAUSE_MS = 120000; // paused this long -> idle clock screen
  var CONTROLS_VISIBLE_MS = 5000;
  var CROSSFADE_MS = 400;

  var params = new URLSearchParams(location.search);
  var token = params.get('t') || storageGet('displayToken') || '';
  if (params.get('t')) storageSet('displayToken', params.get('t'));
  // Positive = show lyrics later. Saved per device.
  var syncOffsetMs = Number(storageGet('syncOffsetMs')) || 0;
  if (params.get('lite') === '1') document.body.classList.add('lite');

  // ---------- Elements ----------

  function $(id) { return document.getElementById(id); }
  var el = {
    player: $('player'),
    idle: $('idle'),
    notice: $('notice'),
    noticeTitle: $('notice-title'),
    noticeBody: $('notice-body'),
    artWrap: $('art-wrap'),
    arts: document.querySelectorAll('.art'),
    controls: $('controls'),
    meta: $('meta'),
    title: $('title'),
    artist: $('artist'),
    fill: $('progress-fill'),
    elapsed: $('elapsed'),
    total: $('total'),
    panel: $('lyrics-panel'),
    lyrics: $('lyrics'),
    message: $('lyrics-message'),
    bgLayers: document.querySelectorAll('.bg-layer'),
    idleArt: $('idle-art'),
    clock: $('clock'),
    date: $('date'),
    idleLast: $('idle-last'),
    toast: $('toast')
  };

  // ---------- State ----------

  var state = {
    mode: null,          // 'player' | 'idle' | 'notice'
    trackKey: null,
    track: null,
    playing: false,
    durationMs: 0,
    basePos: 0,          // playback position (ms) at baseTime
    baseTime: 0,         // performance.now() of basePos
    pausedSince: 0,
    lyricsKind: null,    // 'synced' | 'plain' | null
    lines: [],
    lineEls: [],
    lineClass: [],
    lineCenters: [],
    panelHeight: 0,
    activeIdx: -2,
    plainTop: 0,
    plainEnd: 0,
    lastPlainY: null,
    lastFrac: -1,
    lastSec: -1,
    rafId: 0,
    artIdx: 0,
    bgIdx: 0,
    lastPlayed: storageGetJson('lastPlayed'),
    pollTimer: 0,
    failures: 0
  };

  // ---------- Small helpers ----------

  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function storageGetJson(k) { try { return JSON.parse(storageGet(k)); } catch (e) { return null; } }

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = { 'X-Display-Token': token };
    opts.cache = 'no-store';
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.message || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = body.error;
          throw err;
        }
        return body;
      });
    });
  }

  var toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3500);
  }

  // ---------- Modes ----------

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    el.player.classList.toggle('hidden', mode !== 'player');
    el.idle.classList.toggle('hidden', mode !== 'idle');
    el.notice.classList.toggle('hidden', mode !== 'notice');
    document.body.classList.toggle('idle-mode', mode === 'idle');
    if (mode === 'idle') {
      showIdle();
    } else {
      stopClock();
    }
    if (mode === 'player') {
      // Layout may have been skipped while hidden.
      measureLyrics();
      applyActive(true);
    }
    updateLoop();
  }

  function showNotice(title, html) {
    el.noticeTitle.textContent = title;
    el.noticeBody.innerHTML = html;
    setMode('notice');
  }

  // ---------- Polling & sync ----------

  function schedulePoll(ms) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(poll, ms);
  }

  function lyricShift() {
    return LYRIC_LEAD_MS - syncOffsetMs;
  }

  function poll() {
    if (!token) {
      startPairing();
      return;
    }
    var sent = performance.now();
    api('/api/now-playing')
      .then(function (data) {
        state.failures = 0;
        onNowPlaying(data, sent, performance.now());
        schedulePoll(document.hidden ? POLL_MS * 4 : POLL_MS);
      })
      .catch(function (err) {
        state.failures++;
        if (err.code === 'bad_token') {
          // Token changed on the server (or a typo): pair this screen again.
          token = '';
          storageSet('displayToken', '');
          startPairing();
          return;
        }
        if (err.code === 'not_connected' || err.code === 'not_configured') {
          showNotice('Spotify isn\'t connected yet', 'On a computer, open <code>/auth/login?key=YOUR_ADMIN_KEY</code> on this server and log in once. This screen will update by itself.');
          schedulePoll(10000);
          return;
        }
        // Network blip or Spotify hiccup: keep the local clock running, retry with backoff.
        if (state.failures === 4) toast('Reconnecting…');
        schedulePoll(Math.min(POLL_MS * Math.pow(1.5, state.failures), 20000));
      });
  }

  function currentPos(now) {
    if (!state.playing) return state.basePos;
    var pos = state.basePos + (now - state.baseTime);
    return state.durationMs ? Math.min(pos, state.durationMs) : pos;
  }

  function onNowPlaying(data, sent, received) {
    var hasItem = Boolean(data.trackId) || data.type === 'ad';

    if (data.lastPlayed && data.lastPlayed.albumArtUrl) rememberLastPlayed(data.lastPlayed);

    if (!hasItem) {
      state.playing = false;
      state.trackKey = null;
      setMode('idle');
      return;
    }

    var key = data.trackId || data.type;
    var changed = key !== state.trackKey;
    if (changed) onTrackChange(data, key);
    state.track = data;
    state.durationMs = data.durationMs || 0;

    // Spotify's progress was measured roughly half a round trip ago.
    var serverPos = data.progressMs + (data.isPlaying ? (received - sent) / 2 : 0);
    var localPos = currentPos(received);
    var drift = serverPos - localPos;
    if (changed || data.isPlaying !== state.playing || Math.abs(drift) > 350) {
      state.basePos = serverPos;
      state.baseTime = received;
    } else if (Math.abs(drift) > 60) {
      // Small drift: correct halfway so the progress bar never visibly jumps.
      state.basePos += drift / 2;
    }

    if (data.isPlaying) {
      state.pausedSince = 0;
    } else if (!state.pausedSince || data.isPlaying !== state.playing) {
      state.pausedSince = Date.now();
    }
    state.playing = data.isPlaying;
    el.controls.classList.toggle('playing', state.playing);
    el.total.textContent = fmt(state.durationMs);

    if (!state.playing && state.pausedSince && Date.now() - state.pausedSince > IDLE_AFTER_PAUSE_MS) {
      setMode('idle');
    } else {
      setMode('player');
    }
    renderFrame(performance.now());
    updateLoop();
  }

  // ---------- Track change ----------

  function onTrackChange(data, key) {
    state.trackKey = key;
    state.lastSec = -1;
    state.lastFrac = -1;

    swapArt(data.albumArtUrl);
    updateBackground(data.albumArtUrl, key);

    if (data.trackId && data.albumArtUrl) {
      rememberLastPlayed({ title: data.title, artists: data.artists, albumArtUrl: data.albumArtUrl });
    }

    // Fade out text and lyrics, swap content, fade back in.
    el.meta.classList.add('fading');
    el.panel.classList.add('fading');
    var lyricsPromise = data.type === 'track' && data.trackId ? loadLyrics(data.trackId) : null;

    setTimeout(function () {
      if (state.trackKey !== key) return;
      el.title.textContent = data.title || '';
      el.artist.textContent = (data.artists || []).join(', ');
      el.meta.classList.remove('fading');

      if (data.type === 'ad') {
        showLyricsMessage('Advertisement', 'Back to the music shortly');
        el.panel.classList.remove('fading');
      } else if (data.type === 'episode') {
        showLyricsMessage('Podcast', 'Lyrics aren\'t available for podcasts');
        el.panel.classList.remove('fading');
      } else if (!lyricsPromise) {
        showLyricsMessage('No lyrics available', '');
        el.panel.classList.remove('fading');
      } else {
        clearLyrics();
        lyricsPromise.then(function (result) {
          if (state.trackKey !== key) return;
          renderLyrics(result);
          el.panel.classList.remove('fading');
        });
      }
    }, CROSSFADE_MS);
  }

  function loadLyrics(trackId) {
    return api('/api/lyrics?trackId=' + encodeURIComponent(trackId)).catch(function (err) {
      return { status: 'error', message: err.message };
    });
  }

  // ---------- Album art & background ----------

  function swapArt(url) {
    var next = el.arts[1 - state.artIdx];
    var cur = el.arts[state.artIdx];
    if (!url) {
      cur.classList.remove('visible');
      return;
    }
    next.onload = function () {
      next.classList.add('visible');
      cur.classList.remove('visible');
      state.artIdx = 1 - state.artIdx;
    };
    next.onerror = function () { cur.classList.remove('visible'); };
    next.src = url;
  }

  function updateBackground(url, key) {
    if (!url) {
      paintBackground(fallbackPalette(key || 'none'));
      return;
    }
    extractPalette(url, function (palette) {
      if (state.trackKey !== key && state.mode !== 'idle') return;
      paintBackground(palette || fallbackPalette(key));
      if (state.lastPlayed && state.lastPlayed.albumArtUrl === url && palette) {
        state.lastPlayed.palette = palette;
        storageSet('lastPlayed', JSON.stringify(state.lastPlayed));
      }
    });
  }

  // Tries the CDN directly (needs CORS), then the same-origin proxy.
  function extractPalette(url, done) {
    loadImage(url, true, function (img) {
      var p = img && paletteFromImage(img);
      if (p) return done(p);
      var proxied = '/api/art?url=' + encodeURIComponent(url) + '&t=' + encodeURIComponent(token);
      loadImage(proxied, false, function (img2) {
        done(img2 && paletteFromImage(img2));
      });
    });
  }

  function loadImage(src, cors, cb) {
    var img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = function () { cb(img); };
    img.onerror = function () { cb(null); };
    img.src = src;
  }

  function paletteFromImage(img) {
    try {
      var size = 24;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      var data = ctx.getImageData(0, 0, size, size).data; // throws if tainted
      var buckets = {};
      for (var i = 0; i < data.length; i += 4) {
        var r = data[i], g = data[i + 1], b = data[i + 2];
        var key = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5);
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var sat = max ? (max - min) / max : 0;
        // Favour colourful, mid-bright pixels; still count greys a little.
        var weight = 1 + sat * 3 + (max > 40 && max < 245 ? 1 : 0);
        var bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, w: 0 });
        bk.r += r * weight; bk.g += g * weight; bk.b += b * weight; bk.w += weight;
      }
      var list = Object.keys(buckets).map(function (k) {
        var bk = buckets[k];
        return { r: bk.r / bk.w, g: bk.g / bk.w, b: bk.b / bk.w, w: bk.w };
      }).sort(function (a, b) { return b.w - a.w; });

      var picked = [];
      for (var j = 0; j < list.length && picked.length < 4; j++) {
        var cand = list[j];
        var distinct = picked.every(function (p) {
          return Math.abs(p.r - cand.r) + Math.abs(p.g - cand.g) + Math.abs(p.b - cand.b) > 70;
        });
        if (distinct) picked.push(cand);
      }
      while (picked.length && picked.length < 4) picked.push(picked[picked.length % picked.length]);
      return picked.length ? picked.map(function (p) { return [Math.round(p.r), Math.round(p.g), Math.round(p.b)]; }) : null;
    } catch (e) {
      return null; // CORS-tainted canvas
    }
  }

  function fallbackPalette(seed) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    var base = h % 360;
    return [0, 40, 200, 320].map(function (off, i) { return hsl((base + off) % 360, 0.55, 0.32 + i * 0.04); });
  }

  function hsl(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(function (v) { return Math.round((v + m) * 255); });
  }

  // Paints soft blobs into a tiny canvas; CSS scales it up, which blurs it for free.
  function paintBackground(palette) {
    var next = el.bgLayers[1 - state.bgIdx];
    var cur = el.bgLayers[state.bgIdx];
    var ctx = next.getContext('2d');
    var w = next.width, h = next.height;

    function dim(c, f) { return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)]; }
    function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

    var base = dim(palette[0], 0.5);
    ctx.fillStyle = rgba(base, 1);
    ctx.fillRect(0, 0, w, h);
    var blobs = [
      [0.15, 0.2, 0.75, palette[0]],
      [0.85, 0.25, 0.65, palette[1]],
      [0.7, 0.9, 0.8, palette[2]],
      [0.2, 0.85, 0.6, palette[3]],
      [0.5, 0.5, 0.45, palette[1]]
    ];
    blobs.forEach(function (b) {
      var x = b[0] * w, y = b[1] * h, r = b[2] * w;
      var col = b[3];
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(col, 0.9));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });

    next.classList.add('visible');
    cur.classList.remove('visible');
    state.bgIdx = 1 - state.bgIdx;
  }

  // ---------- Lyrics rendering ----------

  function clearLyrics() {
    state.lyricsKind = null;
    state.lines = [];
    state.lineEls = [];
    state.lineClass = [];
    state.lineCenters = [];
    state.activeIdx = -2;
    state.lastPlainY = null;
    el.lyrics.className = 'lyrics';
    el.lyrics.textContent = '';
    el.message.classList.remove('show');
  }

  function showLyricsMessage(title, sub) {
    clearLyrics();
    el.message.innerHTML = '';
    el.message.appendChild(document.createTextNode(title));
    if (sub) {
      var small = document.createElement('small');
      small.textContent = sub;
      el.message.appendChild(small);
    }
    el.message.classList.add('show');
  }

  function renderLyrics(result) {
    if (result.status === 'synced' && result.lines && result.lines.length) {
      renderSynced(result.lines);
    } else if (result.status === 'synced' || result.status === 'plain') {
      renderPlain(result.plainLyrics || (result.lines || []).map(function (l) { return l.text; }).join('\n'));
    } else if (result.status === 'instrumental') {
      showLyricsMessage('Instrumental', 'Enjoy the music');
    } else if (result.status === 'error') {
      showLyricsMessage('No lyrics available', 'Couldn\'t reach the lyrics service');
    } else {
      showLyricsMessage('No lyrics available', '');
    }
  }

  // Builds timed items: sung lines with per-word timings, plus interludes
  // ("gap" items shown as three filling dots) for intros and long breaks.
  function buildItems(lines, durationMs) {
    var items = [];
    var songEnd = durationMs || (lines[lines.length - 1].timeMs + 8000);
    if (lines[0].timeMs > 3000) items.push({ kind: 'gap', timeMs: 0, endMs: lines[0].timeMs });

    lines.forEach(function (line, i) {
      var next = i + 1 < lines.length ? lines[i + 1].timeMs : songEnd;
      var span = Math.max(300, next - line.timeMs);
      if (!line.text) {
        if (span > 2500) items.push({ kind: 'gap', timeMs: line.timeMs, endMs: next });
        else items.push({ kind: 'line', timeMs: line.timeMs, endMs: next, words: [] });
        return;
      }
      var words = line.words && line.words.length ? timedWords(line.words, line.timeMs, next) : estimateWords(line.text, line.timeMs, span);
      var singEnd = words.length ? words[words.length - 1].end : next;
      items.push({ kind: 'line', timeMs: line.timeMs, endMs: next, words: words });
      // Long silence after a line: show interlude dots once the line has surely finished.
      if (next - line.timeMs > 12000 && i + 1 < lines.length) {
        var gapStart = Math.max(singEnd + 1500, line.timeMs + 6000);
        if (next - gapStart > 4000) items.push({ kind: 'gap', timeMs: gapStart, endMs: next });
      }
    });
    return items;
  }

  // Real word timings from enhanced LRC (chunks may hold several words).
  function timedWords(chunks, lineStart, lineEnd) {
    var out = [];
    chunks.forEach(function (c, i) {
      var cEnd = i + 1 < chunks.length ? chunks[i + 1].timeMs : Math.min(lineEnd, c.timeMs + Math.max(500, c.text.length * 110));
      out = out.concat(estimateWords(c.text, c.timeMs, Math.max(120, cEnd - c.timeMs), true));
    });
    return out;
  }

  // Spread a line's singing time across its words, weighted by length.
  function estimateWords(text, start, span, exact) {
    var parts = text.split(/\s+/).filter(Boolean);
    var weights = parts.map(function (w) { return w.replace(/[^\wÀ-￿]/g, '').length + 2; });
    var total = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    var letters = total - parts.length * 2;
    // Typical singing pace; never longer than the time until the next line.
    var est = letters * 75 + parts.length * 110 + 350;
    // Singers usually stretch a line across most of the gap before the next one.
    var singDur = exact ? span : Math.min(span - 200, Math.max(est, Math.min(span * 0.8, est * 2.2)));
    singDur = Math.max(Math.min(span, 400), singDur);
    var t = start;
    return parts.map(function (w, i) {
      var d = singDur * weights[i] / total;
      var word = { text: w, start: t, end: t + d };
      t += d;
      return word;
    });
  }

  function renderSynced(lines) {
    clearLyrics();
    var items = buildItems(lines, state.durationMs);

    var frag = document.createDocumentFragment();
    items.forEach(function (item, idx) {
      var div = document.createElement('div');
      item.wordEls = [];
      item.wordP = [];
      if (item.kind === 'gap') {
        div.className = 'line gap';
        div.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        item.dotEls = div.querySelectorAll('i');
      } else {
        div.className = 'line';
        item.words.forEach(function (w, i) {
          if (i) div.appendChild(document.createTextNode(' '));
          var span = document.createElement('span');
          span.className = 'w';
          span.textContent = w.text;
          div.appendChild(span);
          item.wordEls.push(span);
          item.wordP.push(-1);
        });
        if (!item.words.length) div.textContent = ' ';
        div.setAttribute('data-i', idx);
      }
      frag.appendChild(div);
      state.lineEls.push(div);
      state.lineClass.push(div.className);
    });
    state.lines = items;
    state.lyricsKind = 'synced';
    el.lyrics.className = 'lyrics no-anim';
    el.lyrics.appendChild(frag);
    measureLyrics();
    applyActive(true);
  }

  function renderPlain(text) {
    clearLyrics();
    var frag = document.createDocumentFragment();
    var note = document.createElement('div');
    note.className = 'plain-note';
    note.textContent = 'Lyrics not synced';
    frag.appendChild(note);
    text.split(/\r?\n/).forEach(function (t) {
      var div = document.createElement('div');
      div.className = 'line';
      div.textContent = t || ' ';
      frag.appendChild(div);
    });
    state.lyricsKind = 'plain';
    el.lyrics.className = 'lyrics plain';
    el.lyrics.appendChild(frag);
    measureLyrics();
  }

  // One batched layout read; everything after this is transform-only.
  function measureLyrics() {
    if (state.mode !== 'player') return;
    state.panelHeight = el.panel.clientHeight;
    if (state.lyricsKind === 'synced') {
      state.lineCenters = state.lineEls.map(function (d) { return d.offsetTop + d.offsetHeight / 2; });
    } else if (state.lyricsKind === 'plain') {
      var contentH = el.lyrics.offsetHeight;
      state.plainTop = state.panelHeight * 0.18;
      state.plainEnd = Math.min(state.plainTop, state.panelHeight * 0.72 - contentH);
      state.lastPlainY = null;
    }
  }

  function findActive(pos) {
    var lines = state.lines;
    var i = state.activeIdx < 0 ? 0 : state.activeIdx;
    if (i >= lines.length) i = lines.length - 1;
    // Usually we only move by one line, so walk instead of searching.
    while (i > 0 && lines[i].timeMs > pos) i--;
    while (i + 1 < lines.length && lines[i + 1].timeMs <= pos) i++;
    return lines.length && lines[i].timeMs <= pos ? i : -1;
  }

  // Lines blur more the further they are from the active one (both ways).
  function classFor(i, active) {
    var base = state.lines[i].kind === 'gap' ? 'line gap' : 'line';
    if (i === active) return base + ' active';
    var d = Math.abs(i - active);
    var cls = base + (i < active ? ' past' : ' future');
    if (d === 1) return cls + ' near';
    if (d === 2) return cls + ' blur1';
    if (d <= 4) return cls + ' blur2';
    if (d <= 9) return cls + ' blur3';
    return cls;
  }

  function applyActive(instant) {
    if (state.lyricsKind !== 'synced' || !state.lines.length) return;
    var idx = findActive(currentPos(performance.now()) + lyricShift());
    setActive(idx, instant);
  }

  function setActive(idx, instant) {
    var prev = state.activeIdx;
    if (idx === prev && !instant) return;
    state.activeIdx = idx;

    // Only touch lines whose class can have changed.
    var lo = 0, hi = state.lineEls.length - 1;
    if (!instant && prev >= -1) {
      lo = Math.max(0, Math.min(prev, idx) - 10);
      hi = Math.min(hi, Math.max(prev, idx) + 10);
    }
    for (var i = lo; i <= hi; i++) {
      var cls = classFor(i, idx);
      if (state.lineClass[i] !== cls) {
        state.lineEls[i].className = cls;
        state.lineClass[i] = cls;
      }
    }

    if (idx >= 0) resetWords(state.lines[idx]);

    var anchor = idx < 0 ? 0 : idx;
    var y = state.panelHeight * ACTIVE_LINE_POSITION - (state.lineCenters[anchor] || 0);
    if (instant) {
      el.lyrics.classList.add('no-anim');
      el.lyrics.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
      // Re-enable the easing on the next frame.
      requestAnimationFrame(function () { el.lyrics.classList.remove('no-anim'); });
    } else {
      el.lyrics.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
    }
  }

  // ---------- Word-by-word fill ----------

  function resetWords(item) {
    for (var i = 0; i < item.wordEls.length; i++) {
      item.wordP[i] = -1;
      item.wordEls[i].className = 'w';
      item.wordEls[i].style.backgroundPosition = '';
    }
    if (item.dotEls) {
      for (var k = 0; k < item.dotEls.length; k++) item.dotEls[k].style.opacity = '';
      state.lineEls[state.lines.indexOf(item)].classList.remove('ending');
    }
  }

  // The fill edge sweeps across each word as it's sung (background-position
  // on a text-clipped gradient: 0.8 = unsung, 0.2 = fully sung).
  function updateWords(item, pos) {
    for (var i = 0; i < item.words.length; i++) {
      var w = item.words[i];
      var p = (pos - w.start) / (w.end - w.start);
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      p = Math.round(p * 50) / 50;
      if (p === item.wordP[i]) continue;
      var prev = item.wordP[i];
      item.wordP[i] = p;
      var span = item.wordEls[i];
      span.style.backgroundPosition = ((0.8 - 0.6 * p) * 100).toFixed(1) + '% 0';
      var cls = p >= 1 ? 'w sung' : p > 0 ? 'w cur' : 'w';
      if (prev < 0 || cls !== span.className) span.className = cls;
    }
  }

  function updateDots(item, pos) {
    var p = (pos - item.timeMs) / Math.max(1, item.endMs - item.timeMs);
    var p3 = Math.round(Math.max(0, Math.min(1, p)) * 60) / 20;
    if (p3 === item.lastP3) return;
    item.lastP3 = p3;
    for (var k = 0; k < 3; k++) {
      var f = Math.max(0, Math.min(1, p3 - k));
      item.dotEls[k].style.opacity = (0.25 + 0.75 * f).toFixed(2);
    }
    // Dots shrink away just before the next line starts.
    var lineEl = state.lineEls[state.lines.indexOf(item)];
    var ending = item.endMs - pos < 600;
    if (ending !== lineEl.classList.contains('ending')) lineEl.classList.toggle('ending', ending);
  }

  // ---------- Animation loop ----------

  function renderFrame(now) {
    if (state.mode !== 'player') return;
    var pos = currentPos(now);
    var dur = state.durationMs;

    var frac = dur ? Math.min(1, pos / dur) : 0;
    if (Math.abs(frac - state.lastFrac) > 0.0004) {
      el.fill.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
      state.lastFrac = frac;
    }
    var sec = Math.floor(pos / 1000);
    if (sec !== state.lastSec) {
      el.elapsed.textContent = fmt(pos);
      state.lastSec = sec;
    }

    if (state.lyricsKind === 'synced') {
      var lead = pos + lyricShift();
      setActive(findActive(lead), false);
      var item = state.lines[state.activeIdx];
      if (item) {
        if (item.kind === 'gap') updateDots(item, lead);
        else updateWords(item, lead);
      }
    } else if (state.lyricsKind === 'plain' && dur) {
      // Scroll plain lyrics through the song, holding a little at each end.
      var f = Math.max(0, Math.min(1, (pos - 10000) / Math.max(1, dur - 35000)));
      var y = state.plainTop + (state.plainEnd - state.plainTop) * f;
      if (state.lastPlainY === null || Math.abs(y - state.lastPlainY) >= 0.5) {
        el.lyrics.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
        state.lastPlainY = y;
      }
    }
  }

  function loop(now) {
    state.rafId = requestAnimationFrame(loop);
    renderFrame(now);
  }

  function updateLoop() {
    var run = state.mode === 'player' && state.playing && !document.hidden;
    if (run && !state.rafId) {
      state.rafId = requestAnimationFrame(loop);
    } else if (!run && state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
  }

  // ---------- Idle screen ----------

  var clockTimer = 0;
  var lastClockText = '';

  function rememberLastPlayed(lp) {
    var prev = state.lastPlayed;
    if (prev && prev.albumArtUrl === lp.albumArtUrl) return;
    state.lastPlayed = { title: lp.title, artists: lp.artists, albumArtUrl: lp.albumArtUrl };
    storageSet('lastPlayed', JSON.stringify(state.lastPlayed));
  }

  function showIdle() {
    stopLoopNow();
    var lp = state.lastPlayed;
    if (lp && lp.albumArtUrl) {
      el.idleArt.src = lp.albumArtUrl;
      el.idleArt.classList.remove('empty');
      el.idleLast.textContent = 'Last played · ' + lp.title + (lp.artists && lp.artists.length ? ' — ' + lp.artists.join(', ') : '');
      if (lp.palette) paintBackground(lp.palette);
      else updateBackground(lp.albumArtUrl, 'idle:' + lp.albumArtUrl);
    } else {
      el.idleArt.classList.add('empty');
      el.idleLast.textContent = '';
      paintBackground(fallbackPalette('idle'));
    }
    tickClock();
    clearInterval(clockTimer);
    clockTimer = setInterval(tickClock, 1000);
  }

  function stopClock() {
    clearInterval(clockTimer);
    clockTimer = 0;
  }

  function stopLoopNow() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  function tickClock() {
    var d = new Date();
    var text = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
    if (text === lastClockText) return;
    lastClockText = text;
    el.clock.textContent = text;
    el.date.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // ---------- Touch controls ----------

  var controlsTimer = 0;

  function showControls() {
    el.controls.classList.add('show');
    el.controls.setAttribute('aria-hidden', 'false');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(hideControls, CONTROLS_VISIBLE_MS);
  }

  function hideControls() {
    el.controls.classList.remove('show');
    el.controls.setAttribute('aria-hidden', 'true');
  }

  el.artWrap.addEventListener('click', function () {
    if (el.controls.classList.contains('show')) hideControls();
    else showControls();
  });

  Array.prototype.forEach.call(el.controls.querySelectorAll('button[data-action]'), function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      showControls(); // restart the 5s timer
      var action = btn.getAttribute('data-action');
      if (action === 'toggle') action = state.playing ? 'pause' : 'play';
      sendControl(action);
    });
  });

  // Earlier / Later: nudge lyric timing in 0.1s steps, remembered on this device.
  function showSyncValue() {
    var s = (syncOffsetMs / 1000).toFixed(1);
    $('sync-value').textContent = 'Timing ' + (syncOffsetMs > 0 ? '+' : '') + s + 's';
  }
  showSyncValue();
  Array.prototype.forEach.call(el.controls.querySelectorAll('button[data-sync]'), function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      showControls();
      syncOffsetMs = Math.max(-3000, Math.min(3000, syncOffsetMs + Number(btn.getAttribute('data-sync'))));
      storageSet('syncOffsetMs', String(syncOffsetMs));
      showSyncValue();
      applyActive(false);
    });
  });

  // ---------- Pairing (so the Echo never has to type the long token) ----------

  var pairTimer = 0;
  var pairing = false;

  function startPairing() {
    if (pairing) return;
    pairing = true;
    clearTimeout(pairTimer);
    fetch('/pair/start', { method: 'POST', cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (p) {
        if (!p.code) throw new Error('no code');
        var html = 'On your phone or computer, open <code>' + location.host + '/pair</code><br>and enter this code:' +
          '<span class="pair-code">' + p.code.slice(0, 3) + ' ' + p.code.slice(3) + '</span>';
        showNotice('Link this screen', html);
        var expires = Date.now() + p.expiresInMs;
        (function check() {
          if (Date.now() > expires) { pairing = false; startPairing(); return; }
          fetch('/pair/status?id=' + encodeURIComponent(p.id), { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (s) {
              if (s.status === 'approved' && s.token) {
                token = s.token;
                storageSet('displayToken', token);
                pairing = false;
                state.mode = null;
                poll();
              } else if (s.status === 'pending') {
                pairTimer = setTimeout(check, 2000);
              } else {
                pairing = false;
                startPairing();
              }
            })
            .catch(function () { pairTimer = setTimeout(check, 4000); });
        })();
      })
      .catch(function () {
        pairing = false;
        showNotice('Can\'t reach the server', 'Retrying…');
        pairTimer = setTimeout(startPairing, 5000);
      });
  }

  el.lyrics.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== el.lyrics && !node.hasAttribute('data-i')) node = node.parentNode;
    if (!node || node === el.lyrics || state.lyricsKind !== 'synced') return;
    var item = state.lines[Number(node.getAttribute('data-i'))];
    if (item) seekTo(item.timeMs);
  });

  function seekTo(ms) {
    var target = Math.max(0, ms - 50);
    var prev = { basePos: state.basePos, baseTime: state.baseTime };
    state.basePos = target;
    state.baseTime = performance.now();
    renderFrame(performance.now());
    api('/api/control/seek?positionMs=' + Math.round(target), { method: 'POST' })
      .then(function () { schedulePoll(1100); })
      .catch(function (err) {
        state.basePos = prev.basePos + (performance.now() - prev.baseTime) * (state.playing ? 1 : 0);
        state.baseTime = performance.now();
        toast(err.message || 'Couldn\'t seek');
      });
  }

  function sendControl(action) {
    var now = performance.now();
    var wasPlaying = state.playing;
    if (action === 'play' || action === 'pause') {
      // Optimistic: freeze or resume the local clock immediately.
      state.basePos = currentPos(now);
      state.baseTime = now;
      state.playing = action === 'play';
      el.controls.classList.toggle('playing', state.playing);
      updateLoop();
    }
    api('/api/control/' + action, { method: 'POST' })
      .then(function () { schedulePoll(1100); })
      .catch(function (err) {
        if (action === 'play' || action === 'pause') {
          state.basePos = currentPos(performance.now());
          state.baseTime = performance.now();
          state.playing = wasPlaying;
          el.controls.classList.toggle('playing', state.playing);
          updateLoop();
        }
        toast(err.message || 'That didn\'t work');
      });
  }

  // ---------- Keep the screen awake ----------

  var wakeLock = null;
  var keepAwakeVideo = null;

  function requestWakeLock() {
    if (document.hidden) return;
    if ('wakeLock' in navigator && window.isSecureContext) {
      if (wakeLock) return;
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () { wakeLock = null; });
      }).catch(startVideoFallback);
    } else {
      startVideoFallback();
    }
  }

  // Fallback: a tiny, muted, looping video stream keeps many browsers awake.
  function startVideoFallback() {
    if (keepAwakeVideo) {
      keepAwakeVideo.play().catch(function () {});
      return;
    }
    var canvas = document.createElement('canvas');
    if (!canvas.captureStream) return;
    canvas.width = canvas.height = 2;
    var ctx = canvas.getContext('2d');
    var flip = false;
    setInterval(function () {
      flip = !flip;
      ctx.fillStyle = flip ? '#000' : '#010101';
      ctx.fillRect(0, 0, 2, 2);
    }, 1000);
    var v = document.createElement('video');
    v.muted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;bottom:0;';
    v.srcObject = canvas.captureStream(1);
    document.body.appendChild(v);
    keepAwakeVideo = v;
    v.play().catch(function () {});
  }

  // ---------- Full screen ----------

  var fsBtn = $('fs-btn');

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function fullscreenSupported() {
    var root = document.documentElement;
    return Boolean(root.requestFullscreen || root.webkitRequestFullscreen) &&
      document.fullscreenEnabled !== false && document.webkitFullscreenEnabled !== false;
  }

  function enterFullscreen(quiet) {
    var root = document.documentElement;
    var fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!fn || fullscreenElement()) return;
    var fail = function () { if (!quiet) toast('This browser won\'t allow full screen'); };
    try {
      var p = fn.call(root);
      if (p && p.catch) p.catch(fail);
    } catch (e) { fail(); }
  }

  function toggleFullscreen() {
    if (fullscreenElement()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        var p = exit.call(document);
        if (p && p.catch) p.catch(function () {});
      }
    } else {
      enterFullscreen(false);
    }
  }

  function updateFullscreenButton() {
    fsBtn.textContent = fullscreenElement() ? 'Exit full screen' : 'Full screen';
  }

  if (!fullscreenSupported()) fsBtn.parentNode.classList.add('unsupported');
  fsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    showControls();
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

  // Double-tap anywhere (except buttons, the art and lyric lines) toggles full screen.
  var lastTap = { t: 0, x: 0, y: 0 };
  document.addEventListener('pointerup', function (e) {
    var node = e.target;
    while (node && node !== document.body) {
      if (node.tagName === 'BUTTON' || node.tagName === 'A' || node.tagName === 'INPUT' ||
          node === el.artWrap || (node.classList && node.classList.contains('line'))) return;
      node = node.parentNode;
    }
    var now = Date.now();
    if (now - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) < 40 && Math.abs(e.clientY - lastTap.y) < 40) {
      lastTap.t = 0;
      toggleFullscreen();
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  });

  document.addEventListener('keydown', function (e) {
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen();
  });

  // First touch: re-request the wake lock (some browsers need a gesture) and
  // go full screen automatically on touch screens like the Echo.
  var firstGesture = true;
  document.addEventListener('pointerdown', function () {
    requestWakeLock();
    if (keepAwakeVideo) keepAwakeVideo.play().catch(function () {});
    if (!firstGesture) return;
    firstGesture = false;
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (coarse) enterFullscreen(true);
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      requestWakeLock();
      schedulePoll(0);
    }
    updateLoop();
  });

  // ---------- Resize ----------

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      measureLyrics();
      applyActive(true);
      renderFrame(performance.now());
    }, 150);
  });

  // ---------- Start ----------

  paintBackground(state.lastPlayed && state.lastPlayed.palette ? state.lastPlayed.palette : fallbackPalette('start'));
  requestWakeLock();
  poll();
})();
