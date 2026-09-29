// Playback, progress bar, search, contents, bookmarks, the library of recent
// documents, and settings. Text extraction lives in extract.js and only hands
// this file [{ text, page, soft, heading }] units; syncing to Supabase lives
// in sync.js and does nothing unless config.js has a project filled in.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const Sync = window.SRSync;

  // localStorage holds small per-browser things (settings, positions,
  // bookmarks); IndexedDB holds the extracted text of recent documents. Both
  // are allowed to fail, in which case the reader just forgets between visits.
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sr:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('sr:' + k, JSON.stringify(v)); } catch { /* private mode or full */ } },
    del(k) { try { localStorage.removeItem('sr:' + k); } catch { /* ignore */ } },
  };

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    wpm: 300, chunk: 1, size: 1, font: 'atkinson', focal: 'red', guides: true,
    pauses: true, easeIn: true, resumeSentence: false, context: true, theme: 'auto',
    aiAuto: true, skipFront: true,
  };
  const FONTS = {
    atkinson: { family: '"Atkinson Hyperlegible", sans-serif', css: null },
    lexend: { family: '"Lexend", sans-serif', css: 'Lexend:wght@400;600' },
    literata: { family: '"Literata", Georgia, serif', css: 'Literata:opsz,wght@7..72,400;7..72,600' },
    mono: { family: '"IBM Plex Mono", ui-monospace, Menlo, monospace', css: 'IBM+Plex+Mono:wght@400;600' },
  };
  const FOCAL = { red: 'var(--focal)', orange: '#e8730c', blue: '#3b6fe0', green: '#1f9d55', none: 'currentColor' };
  let set = { ...DEFAULTS, ...store.get('settings', {}) };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  const fmt = n => n.toLocaleString();

  const S = {
    words: [], page: null, para: null, norm: null, weight: null, suffix: null,
    pageStart: [], pageCount: 0, pageLabel: 'Page', hasPages: false,
    sections: [], secCur: -2,
    idx: 0, end: 1, playing: false, timer: 0, due: 0, warm: 0, resumeBack: false,
    key: '', title: '', doc: null, lastSave: 0, bookmarks: [],
    fileSections: [], sectionsFrom: 'file', bodyStart: 0, ai: null,
    hits: [], hitLen: 0, hitQuery: '', hitCur: -1,
  };

  // ---------------------------------------------------------------- library (IndexedDB)

  const LIBRARY_SIZE = 25;
  let dbp = null;
  function db() {
    dbp = dbp || new Promise((resolve, reject) => {
      const req = indexedDB.open('speedreader', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('docs', mode);
      const req = fn(tx.objectStore('docs'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const lib = {
    async all() {
      try { return (await idb('readonly', st => st.getAll())).sort((a, b) => b.openedAt - a.openedAt); } catch { return []; }
    },
    async get(key) { try { return await idb('readonly', st => st.get(key)); } catch { return null; } },
    async put(rec) {
      try {
        await idb('readwrite', st => st.put(rec));
        const all = await lib.all();
        for (const old of all.slice(LIBRARY_SIZE)) await lib.del(old.key);
      } catch { /* storage full or blocked: the document still reads, it just isn't kept */ }
    },
    async del(key) { try { await idb('readwrite', st => st.delete(key)); } catch { /* ignore */ } },
  };

  // Where you are in each document: { i: word index, t: when }.
  const getPos = key => {
    const v = store.get('pos:' + key, null);
    return typeof v === 'number' ? { i: v, t: 0 } : v || { i: 0, t: 0 };
  };

  // ---------------------------------------------------------------- loading a document

  function load(r, key) {
    const words = [], pages = [], para = [];
    const unitStart = new Int32Array(r.units.length + 1);
    r.units.forEach((u, k) => {
      unitStart[k] = words.length;
      // Soft hyphens, control characters, and private-use glyphs (Symbol and
      // Wingdings bullets in Word-made PDFs) have nothing to read.
      const before = words.length;
      for (const t of u.text.replace(/[\u00AD\u0000-\u0008\u000E-\u001F\uE000-\uF8FF\uFFFD]/g, '').split(/\s+/)) {
        if (!t) continue;
        // A word joined to the next by an em dash reads as two words.
        const parts = t.includes('\u2014') ? t.split(/(?<=\u2014)(?=\S)/) : [t];
        for (const w of parts) { words.push(w); pages.push(u.page || 1); para.push(0); }
      }
      if (words.length > before && (!u.soft || u.heading)) para[para.length - 1] = 1;
    });
    unitStart[r.units.length] = words.length;
    if (!words.length) throw new Error('No readable text was found in this file.');

    const n = words.length;
    if (S.playing) pause();
    savePos();
    S.words = words;
    S.para = Uint8Array.from(para);
    S.page = Int32Array.from(pages);
    // Page numbers only when the file records them. Formats that don't
    // (EPUB, HTML, plain text...) get no page numbers rather than made-up ones.
    S.pageLabel = r.pageLabel || 'Page';
    S.pageCount = r.pagesReal ? Math.max(r.pageCount || 0, pages[n - 1]) : 0;
    S.hasPages = S.pageCount > 1;
    S.pageStart = [];
    if (S.hasPages) {
      // First word of each page. A page with no text points at the next page
      // that has some, so jumping to it still lands somewhere sensible.
      const start = new Array(S.pageCount + 2).fill(-1);
      for (let i = n - 1; i >= 0; i--) start[S.page[i]] = i;
      start[S.pageCount + 1] = n - 1;
      for (let p = S.pageCount; p >= 1; p--) if (start[p] < 0) start[p] = start[p + 1];
      S.pageStart = start;
    }
    S.fileSections = buildSections(r, unitStart, n);
    S.sections = S.fileSections;
    S.sectionsFrom = S.fileSections.length >= 2 ? 'file' : 'none';
    if (S.sections.length < 2) {
      const guess = guessSections(r, unitStart, n);
      if (guess.length >= 2) { S.sections = guess; S.sectionsFrom = 'guess'; }
    }
    S.bodyStart = 0;
    if (S.ai) { S.ai.abort(); S.ai = null; }
    S.secCur = -2;
    S.norm = null;
    S.key = key;
    S.doc = r;
    S.title = r.title || 'Untitled';
    S.bookmarks = store.get('bm:' + key, []).filter(i => i < n);
    S.resumeBack = false;
    clearSearch();
    $('searchInput').value = '';
    closePanels();
    computeWeights();

    $('docTitle').textContent = S.title;
    document.title = S.title + ' \u00B7 Max\'s Speed Reader';
    const notes = [r.note, r.pageNote].filter(Boolean);
    $('note').textContent = notes.join(' ');
    $('note').hidden = !notes.length;
    $('pageForm').hidden = !S.hasPages;
    $('pageWord').textContent = 'Go to ' + S.pageLabel.toLowerCase();
    $('pageInput').max = S.pageCount;
    $('pageInput').value = '';
    $('pageOf').textContent = 'of ' + fmt(S.pageCount);
    const pl = $('pageLabel');
    pl.classList.toggle('nopages', !S.hasPages && !r.pagesReal);
    pl.title = !S.hasPages && !r.pagesReal
      ? 'Only PDFs, slides, spreadsheets, and Word or LibreOffice files saved by those apps record where pages break. This file doesn\'t, so there are no page numbers to go to.'
      : '';
    updateBookmarkCount();
    showReader();

    // Showing the saved position isn't a move, so don't save it straight back
    // (on a new device that would push position 0 over the real one).
    S.lastSave = Date.now();
    const pos = getPos(key);
    if (pos.i > 0 && pos.i < n - 1) {
      show(pos.i);
      toast(`Picked up where you left off, ${where(pos.i)}. Press Home to start over.`);
    } else show(0);
    setHint();

    // Chapters found by AI earlier are reused; otherwise, for a file with no
    // contents of its own, ask for them now if that's switched on.
    const found = store.get('ai:' + key, null);
    if (found) applyStructure(found, false);
    else {
      refreshStructureUI();
      if (set.aiAuto && window.SRAI.hasKey() && S.sectionsFrom !== 'file') runAI(true);
    }

    lib.put({ key, title: S.title, format: r.format || '', openedAt: Date.now(), words: n, data: r });
    syncOpened(key, pos).catch(err => console.error(err));
  }

  // Without a contents list of its own, a file's chapters can often still be
  // spotted: short paragraphs that read "Chapter 7", "PART TWO", "Prologue".
  // A heading followed closely by another is a line of a table of contents,
  // not a chapter, and is skipped. A chapter's name on the next line is added.
  const HEADING_WORD = /^(chapter|part|book|section|prologue|epilogue|introduction|preface|foreword|afterword|appendix|interlude|act)\b/i;
  function guessSections(r, unitStart, n) {
    const isHeading = t => {
      const words = t.split(/\s+/).length;
      const numeral = /^([IVXLC]+|\d{1,3})\.?$/.test(t);
      // "Introduction to the method." is a sentence; "Chapter 4." is a heading.
      if (words > 12 || (!numeral && /[,;]$/.test(t)) || (!numeral && /\.$/.test(t) && words > 4)) return false;
      return HEADING_WORD.test(t) || numeral;
    };
    const hits = [];
    r.units.forEach((u, k) => {
      const t = u.text.trim();
      if (!isHeading(t)) return;
      const next = r.units[k + 1] ? r.units[k + 1].text.trim() : '';
      const named = /^(chapter|part|book|act)\s+\S+\.?$|^([IVXLC]+|\d{1,3})\.?$/i.test(t) && next && next.split(/\s+/).length <= 8 && !/[.,;:!?]$/.test(next) && !isHeading(next);
      hits.push({ title: named ? `${t.replace(/\.$/, '')}: ${next}` : t, level: /^(part|book|act)\b/i.test(t) ? 1 : 2, idx: unitStart[k] });
    });
    const kept = hits.filter((h, k) => {
      const next = hits[k + 1], prev = hits[k - 1];
      if (next && next.idx - h.idx < 60) return false;
      if (prev && h.idx - prev.idx < 60 && (!next || next.idx - h.idx < 200)) return false;
      return h.idx < n;
    });
    const minLevel = Math.min(...kept.map(h => h.level), 3);
    return kept.map(h => ({ ...h, level: h.level - minLevel + 1 }));
  }

  // ---------------------------------------------------------------- AI chapters

  function applyStructure(found, announce) {
    const n = S.words.length;
    const secs = (found.sections || []).filter(x => x.idx >= 0 && x.idx < n);
    if (secs.length) { S.sections = secs; S.sectionsFrom = 'ai'; }
    S.bodyStart = found.start > 0 && found.start < n ? found.start : 0;
    S.secCur = -2;
    refreshStructureUI();
    updateMeta();
    // Opening at the very start of a document goes straight to the real text.
    if (set.skipFront && S.bodyStart && S.idx === 0 && !S.playing) {
      jump(S.bodyStart);
      toast(`Skipped the title page and other front matter. Press Home for the very beginning.`, 6000);
    } else if (announce) {
      const where2 = S.bodyStart ? ` The main text starts ${where(S.bodyStart)}.` : '';
      toast(secs.length ? `Found ${secs.length} chapters and sections.${where2}` : `No chapter headings found.${where2}`, 6000);
    }
  }

  function refreshStructureUI() {
    $('contentsBtn').hidden = S.sections.length < 2;
    $('prevSecBtn').hidden = $('nextSecBtn').hidden = S.sections.length < 2;
    $('contentsNote').textContent = S.sectionsFrom === 'ai'
      ? 'Found by Gemini and checked against the text.'
      : S.sectionsFrom === 'guess' ? 'Guessed from headings like "Chapter 1".' : 'From the file.';
    $('useFileContents').hidden = !(S.sectionsFrom === 'ai' && S.fileSections.length >= 2);
    const ai = $('aiBtn');
    if (!S.ai) {
      ai.disabled = false;
      ai.textContent = S.sectionsFrom === 'ai' ? 'Find chapters again' : 'Find chapters (AI)';
    }
    updateSkip();
  }

  function updateSkip() {
    $('skipBtn').hidden = !(S.bodyStart > 0 && S.idx < S.bodyStart);
  }

  async function runAI(auto) {
    if (!S.words.length || S.ai) return;
    if (!window.SRAI.hasKey()) {
      $('settingsPanel').open = true;
      $('aiKey').focus();
      $('aiKey').scrollIntoView({ block: 'center' });
      toast('Add a free Gemini API key here first. It takes a minute at aistudio.google.com/apikey.', 7000);
      return;
    }
    const key = S.key, ctl = new AbortController();
    S.ai = ctl;
    const btn = $('aiBtn');
    btn.disabled = true;
    btn.textContent = 'Finding chapters\u2026';
    if (!S.norm) S.norm = S.words.map(normalize);
    try {
      const found = await window.SRAI.findStructure({
        words: S.words, para: S.para, norm: S.norm, normalize, title: S.title, signal: ctl.signal,
        onProgress: msg => { if (S.ai === ctl) btn.textContent = msg + '\u2026'; },
      });
      if (S.key !== key || ctl.signal.aborted) return;
      store.set('ai:' + key, found);
      Sync.saveStructure(key, found);
      S.ai = null;
      applyStructure(found, true);
      if (found.failed.length) toast(`Some parts couldn't be read: ${found.failed.join('; ')}`, 8000);
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error(err);
      if (!auto || err.status !== 0) toast(err.message || 'Finding chapters didn\'t work.', 8000);
    } finally {
      if (S.ai === ctl) S.ai = null;
      if (S.key === key) refreshStructureUI();
    }
  }

  // Contents come from the file's own table of contents when it has one
  // (PDF bookmarks, an EPUB's contents page, slide titles, sheet names),
  // otherwise from its headings.
  function buildSections(r, unitStart, n) {
    const firstOfPage = p => {
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (S.page[mid] < p) lo = mid + 1; else hi = mid; }
      return lo;
    };
    // A PDF bookmark gives a page and roughly how far down it. The heading's
    // own words usually sit right there, so look for them on that page and
    // take the match nearest the estimate.
    const onPage = o => {
      const start = firstOfPage(o.page);
      const end = o.page < S.page[n - 1] ? firstOfPage(o.page + 1) : n;
      const guess = clamp(start + (o.offset || 0), start, Math.max(start, end - 1));
      const want = o.title.split(/\s+/).map(normalize).filter(Boolean).slice(0, 4);
      if (!want.length) return guess;
      let best = -1;
      for (let i = start; i + want.length <= end; i++) {
        if (want.every((w, j) => normalize(S.words[i + j]) === w) && (best < 0 || Math.abs(i - guess) < Math.abs(best - guess))) best = i;
      }
      return best >= 0 ? best : guess;
    };
    let secs = [];
    if (r.outline && r.outline.length) {
      secs = r.outline.map(o => ({ title: o.title, level: o.level || 1, idx: o.unit != null ? unitStart[o.unit] : onPage(o) }));
    } else {
      r.units.forEach((u, k) => { if (u.heading) secs.push({ title: u.text, level: u.heading, idx: unitStart[k] }); });
    }
    return secs
      .filter(s => s.title && s.idx < n)
      .map(s => ({ ...s, title: s.title.length > 90 ? s.title.slice(0, 88) + '\u2026' : s.title }))
      .sort((a, b) => a.idx - b.idx);
  }

  // The last character that isn't a closing quote or bracket: "end." and
  // "end.)" both end a sentence.
  const CLOSERS = '"\'\u201D\u2019)]';
  function lastMark(t) {
    let k = t.length - 1;
    while (k > 0 && CLOSERS.includes(t[k])) k--;
    return t[k];
  }
  const SENTENCE_END = '.!?\u2026', CLAUSE_END = ',;:\u2013\u2014';

  function computeWeights() {
    const n = S.words.length;
    S.weight = new Float32Array(n);
    S.suffix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      let w = 1;
      if (set.pauses) {
        const t = S.words[i];
        const c = lastMark(t);
        if (S.para[i]) w = 2.6;
        else if (SENTENCE_END.includes(c)) w = 2.2;
        else if (CLAUSE_END.includes(c)) w = 1.5;
        // t.length counts a rare character outside the basic plane as two,
        // which only nudges one pause.
        if (t.length > 8) w += Math.min(0.8, (t.length - 8) * 0.08);
      }
      S.weight[i] = w;
    }
    for (let i = n - 1; i >= 0; i--) S.suffix[i] = S.suffix[i + 1] + S.weight[i];
  }

  // ---------------------------------------------------------------- showing a word

  const endsSentence = i => i < 0 || S.para[i] === 1 || SENTENCE_END.includes(lastMark(S.words[i]));

  // With 2 or 3 words at a time, a group never runs past the end of a
  // sentence or a comma, so phrases stay together.
  function groupEnd(i) {
    const n = S.words.length;
    let j = i + 1;
    while (j < n && j - i < set.chunk && !endsSentence(j - 1) && !',;:'.includes(lastMark(S.words[j - 1]))) j++;
    return j;
  }

  // The focal letter is the middle letter of the word (or group of words),
  // ignoring punctuation stuck to either end. Even lengths take the left of
  // the two middles; a middle that lands on a space moves one letter left.
  function splitWord(w) {
    const m = w.match(/^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u);
    let lead = m[1], core = m[2], trail = m[3];
    if (!core) { core = w; lead = ''; trail = ''; }
    const chars = Array.from(core);
    let i = Math.floor((chars.length - 1) / 2);
    if (/\s/.test(chars[i] || '') && i > 0) i--;
    return [lead + chars.slice(0, i).join(''), chars[i] || '', chars.slice(i + 1).join('') + trail];
  }

  function where(i) {
    const pct = Math.floor(i / Math.max(1, S.words.length - 1) * 100);
    return S.hasPages ? `${S.pageLabel.toLowerCase()} ${fmt(S.page[i])}` : `${pct}% of the way through`;
  }

  function show(i) {
    const n = S.words.length;
    if (!n) return;
    S.idx = clamp(i, 0, n - 1);
    S.end = groupEnd(S.idx);
    const [a, b, c] = splitWord(S.words.slice(S.idx, S.end).join(' '));
    const pre = $('wPre'), piv = $('wPiv'), post = $('wPost'), word = $('word');
    pre.textContent = a; piv.textContent = b; post.textContent = c;
    // Shrink the text only when it would run off the edge.
    word.style.fontSize = '';
    const half = $('stage').clientWidth / 2 - 12;
    const need = Math.max(pre.offsetWidth, post.offsetWidth) + piv.offsetWidth / 2;
    if (need > half) word.style.fontSize = (parseFloat(getComputedStyle(word).fontSize) * half / need) + 'px';
    updateMeta();
    if (!S.playing) renderContext();
    if (Date.now() - S.lastSave > 2000) savePos();
  }

  function savePos() {
    if (!S.key || !S.words.length) return;
    S.lastSave = Date.now();
    store.set('pos:' + S.key, { i: S.idx, t: S.lastSave });
    Sync.pushPosition(S.key, S.idx);
  }

  function updateMeta() {
    const n = S.words.length, i = S.idx;
    const pct = n > 1 ? i / (n - 1) : 0;
    $('fill').style.width = pct * 100 + '%';
    $('thumb').style.left = pct * 100 + '%';
    const scrub = $('scrub');
    scrub.setAttribute('aria-valuenow', i);
    scrub.setAttribute('aria-valuemax', n - 1);
    const pl = $('pageLabel');
    pl.textContent = S.hasPages ? `${S.pageLabel} ${fmt(S.page[i])} of ${fmt(S.pageCount)}`
      : pl.classList.contains('nopages') ? 'No page numbers in this file' : '';
    $('posLabel').textContent = `Word ${fmt(i + 1)} of ${fmt(n)} \u00B7 ${Math.floor(pct * 100)}%`;
    const secs = Math.round(S.suffix[i] * 60 / set.wpm);
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    $('timeLabel').textContent = (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(s).padStart(2, '0') + ' left';
    $('markBtn').setAttribute('aria-pressed', S.bookmarks.includes(i));
    updateSkip();
    updateSection();
  }

  function sectionAt(i) {
    const secs = S.sections;
    let lo = 0, hi = secs.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (secs[mid].idx <= i) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  function updateSection() {
    const k = sectionAt(S.idx);
    if (k === S.secCur) return;
    S.secCur = k;
    const el = $('section');
    el.textContent = k >= 0 && S.sections.length > 1 ? S.sections[k].title : '';
    el.hidden = !el.textContent;
    if (!$('contentsPanel').hidden) markCurrentSection();
  }

  function renderContext() {
    const box = $('context'), out = $('contextText');
    if (S.playing || !S.words.length || !set.context) { box.hidden = true; return; }
    box.hidden = false;
    const a = Math.max(0, S.idx - 45), b = Math.min(S.words.length, S.idx + 75);
    const marks = new Set(S.bookmarks);
    const frag = document.createDocumentFragment();
    if (a > 0) frag.append('\u2026 ');
    for (let i = a; i < b; i++) {
      const sp = document.createElement('span');
      sp.textContent = S.words[i];
      sp.dataset.i = i;
      if (i >= S.idx && i < S.end) sp.className = 'cur';
      if (marks.has(i)) sp.classList.add('bm');
      frag.append(sp, ' ');
      if (S.para[i] && i < b - 1) { const br = document.createElement('span'); br.className = 'br'; frag.append(br); }
    }
    if (b < S.words.length) frag.append('\u2026');
    out.replaceChildren(frag);
  }

  function setHint() {
    const atEnd = S.end >= S.words.length;
    $('hint').textContent = S.playing ? ''
      : atEnd ? 'Finished. Press Space to read it again from the start.'
      : 'Paused. Press Space or click the word to read.';
    $('playIcon').innerHTML = S.playing
      ? '<path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/>'
      : '<path d="M7 4.5v15L19.5 12z"/>';
    $('playBtn').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  }

  // ---------------------------------------------------------------- playback

  // A group's time is the sum of its words' times, so 2 or 3 words at a time
  // reads at the same words per minute. Easing in starts the first few
  // flashes after pressing play a little slower.
  function delay() {
    let w = 0;
    for (let k = S.idx; k < S.end; k++) w += S.weight[k];
    let d = w * 60000 / set.wpm;
    if (set.easeIn && S.warm < 5) d *= 1 + 0.5 * (5 - S.warm) / 5;
    return d;
  }

  // Each word is due at a time measured from when playback started, so small
  // timer delays don't pile up and slow the whole read down.
  function schedule() {
    clearTimeout(S.timer);
    const now = performance.now();
    if (!S.due || S.due < now - 250) S.due = now;
    S.due += delay();
    S.timer = setTimeout(advance, Math.max(0, S.due - now));
  }

  function advance() {
    if (!S.playing) return;
    if (S.end >= S.words.length) { pause(); return; }
    S.warm++;
    show(S.end);
    schedule();
  }

  function play() {
    if (!S.words.length) return;
    if (S.end >= S.words.length) show(0);
    else if (S.resumeBack && set.resumeSentence) show(sentenceStart(S.idx));
    S.playing = true;
    S.due = 0;
    S.warm = 0;
    $('context').hidden = true;
    show(S.idx);
    setHint();
    schedule();
  }

  function pause() {
    S.playing = false;
    S.resumeBack = true;
    clearTimeout(S.timer);
    savePos();
    Sync.flush();
    setHint();
    renderContext();
  }

  const toggle = () => (S.playing ? pause() : play());

  function jump(i) {
    show(i);
    S.due = 0;
    S.resumeBack = false;
    if (S.playing) schedule();
    setHint();
  }

  // Moves by reading time rather than words: 10 seconds is however many words
  // take 10 seconds at the current speed, pauses at punctuation included.
  function skipTime(seconds) {
    if (!S.words.length) return;
    const target = Math.abs(seconds) * 1000, per = 60000 / set.wpm;
    let i = S.idx, t = 0;
    if (seconds < 0) while (i > 0 && t < target) { i--; t += S.weight[i] * per; }
    else while (i < S.words.length - 1 && t < target) { t += S.weight[i] * per; i++; }
    jump(i);
  }

  function sentenceStart(i) { while (i > 0 && !endsSentence(i - 1)) i--; return i; }
  function backSentence() {
    let s = sentenceStart(S.idx);
    if (S.idx - s < 2 && s > 0) s = sentenceStart(s - 1);
    jump(s);
  }
  function fwdSentence() {
    let i = S.idx;
    const last = S.words.length - 1;
    while (i < last && !endsSentence(i)) i++;
    jump(Math.min(i + 1, last));
  }

  function stepSection(dir) {
    if (S.sections.length < 2) return;
    const k = sectionAt(S.idx);
    // "Previous" from inside a section goes to its start first, like a
    // music player's back button.
    let t = dir > 0 ? k + 1 : (k >= 0 && S.idx - S.sections[k].idx > 2 ? k : k - 1);
    t = clamp(t, 0, S.sections.length - 1);
    jump(S.sections[t].idx);
    toast(S.sections[t].title, 1500);
  }

  function stepPage(dir) {
    if (!S.hasPages) return;
    goPage(clamp(S.page[S.idx] + dir, 1, S.pageCount));
  }

  function setWpm(v) {
    set.wpm = clamp(Math.round(v) || 300, 50, 2000);
    $('wpmRange').value = set.wpm;
    $('wpmNum').value = set.wpm;
    saveSettings();
    if (S.words.length) updateMeta();
  }

  // ---------------------------------------------------------------- progress bar

  function idxAt(clientX) {
    const r = $('scrub').getBoundingClientRect();
    const pct = clamp((clientX - r.left) / r.width, 0, 1);
    return Math.round(pct * (S.words.length - 1));
  }

  function wireScrub() {
    const scrub = $('scrub'), tip = $('tip');
    let dragging = false, wasPlaying = false, frame = 0, lastX = 0;
    const showTip = (x, i) => {
      const r = scrub.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = clamp(x - r.left, 40, r.width - 40) + 'px';
      const pct = Math.floor(i / Math.max(1, S.words.length - 1) * 100) + '%';
      const k = sectionAt(i);
      const sec = k >= 0 && S.sections.length > 1 ? S.sections[k].title + ' \u00B7 ' : '';
      tip.textContent = sec + (S.hasPages ? `${S.pageLabel} ${fmt(S.page[i])} \u00B7 ${pct}` : pct);
    };
    // Pointer moves arrive faster than the screen redraws; handle one per frame.
    const onFrame = () => {
      frame = 0;
      const i = idxAt(lastX);
      if (dragging) show(i);
      showTip(lastX, i);
    };
    scrub.addEventListener('pointerdown', e => {
      if (!S.words.length) return;
      dragging = true;
      wasPlaying = S.playing;
      if (S.playing) { S.playing = false; clearTimeout(S.timer); }
      scrub.setPointerCapture(e.pointerId);
      const i = idxAt(e.clientX);
      show(i); showTip(e.clientX, i);
    });
    scrub.addEventListener('pointermove', e => {
      if (!S.words.length) return;
      lastX = e.clientX;
      if (!frame) frame = requestAnimationFrame(onFrame);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      // Clicking the bar focuses it, which would turn the arrow keys into
      // 1% jumps instead of sentence steps.
      scrub.blur();
      S.resumeBack = false;
      if (wasPlaying) play(); else { setHint(); renderContext(); }
    };
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);
    scrub.addEventListener('pointerleave', () => { if (!dragging) tip.hidden = true; });
    scrub.addEventListener('keydown', e => {
      const step = Math.max(1, Math.round(S.words.length / 100));
      if (e.key === 'ArrowRight') { jump(S.idx + step); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'ArrowLeft') { jump(S.idx - step); e.preventDefault(); e.stopPropagation(); }
    });
  }

  // ---------------------------------------------------------------- search

  const normalize = s => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036F]/g, '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}']+/gu, '').replace(/^'+|'+$/g, '');

  // A match lines the query words up against consecutive words in the text.
  // The last query word may be the start of a longer word ("run" finds
  // "running"), and in a phrase the first may be the end of one. Typing
  // lists matches; Enter goes to the next one after where you are.
  function search(q, go) {
    const qw = q.split(/\s+/).map(normalize).filter(Boolean);
    if (!qw.length) { clearSearch(); return; }
    if (!S.norm) S.norm = S.words.map(normalize);
    const N = S.norm, k = qw.length, hits = [];
    for (let i = 0; i + k <= N.length; i++) {
      let ok = true;
      for (let j = 0; j < k && ok; j++) {
        const w = N[i + j], x = qw[j];
        if (j === k - 1) ok = w.startsWith(x);
        else if (j === 0) ok = w.endsWith(x);
        else ok = w === x;
      }
      if (ok) hits.push(i);
    }
    S.hits = hits; S.hitLen = k; S.hitQuery = q.trim(); S.hitCur = -1;
    renderResults();
    if (go && hits.length) stepHit(1);
  }

  // From no current match, "next" means the first match after where you are.
  function stepHit(dir) {
    if (!S.hits.length) return;
    if (S.hitCur < 0) {
      const i = S.hits.findIndex(h => h > S.idx);
      goHit(dir > 0 ? (i < 0 ? 0 : i) : (i < 0 ? S.hits.length - 1 : i - 1));
    } else goHit(S.hitCur + dir);
  }

  function goHit(k) {
    if (!S.hits.length) return;
    S.hitCur = (k + S.hits.length) % S.hits.length;
    if (S.playing) pause();
    jump(S.hits[S.hitCur]);
    $('resCount').textContent = `Match ${fmt(S.hitCur + 1)} of ${fmt(S.hits.length)} for \u201C${S.hitQuery}\u201D`;
    const list = $('resList');
    list.querySelectorAll('button.on').forEach(b => b.classList.remove('on'));
    const btn = list.querySelector(`button[data-k="${S.hitCur}"]`);
    if (btn) { btn.classList.add('on'); scrollWithin(list, btn); }
  }

  function snippet(h, len) {
    const snip = document.createElement('span');
    const a = Math.max(0, h - 7), z = Math.min(S.words.length, h + len + 9);
    snip.append((a > 0 ? '\u2026' : '') + S.words.slice(a, h).join(' ') + ' ');
    const mk = document.createElement('mark');
    mk.textContent = S.words.slice(h, h + len).join(' ');
    snip.append(mk, ' ' + S.words.slice(h + len, z).join(' ') + (z < S.words.length ? '\u2026' : ''));
    return snip;
  }

  function placeLabel(i) {
    return S.hasPages ? `${S.pageLabel === 'Page' ? 'p.' : S.pageLabel} ${fmt(S.page[i])}`
      : Math.floor(i / Math.max(1, S.words.length - 1) * 100) + '%';
  }

  function renderResults() {
    openPanel('results');
    const list = $('resList');
    list.replaceChildren();
    if (!S.hits.length) {
      $('resCount').textContent = `No matches for \u201C${S.hitQuery}\u201D`;
      $('hitMarks').replaceChildren();
      return;
    }
    $('resCount').textContent = `${fmt(S.hits.length)} ${S.hits.length === 1 ? 'match' : 'matches'} for \u201C${S.hitQuery}\u201D`;
    const shown = S.hits.slice(0, 500);
    const frag = document.createDocumentFragment();
    shown.forEach((h, k) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.k = k;
      const pg = document.createElement('span');
      pg.className = 'pg';
      pg.textContent = placeLabel(h);
      b.append(pg, snippet(h, S.hitLen));
      li.append(b);
      frag.append(li);
    });
    if (S.hits.length > shown.length) {
      const li = document.createElement('li');
      li.className = 'more';
      li.textContent = `Showing the first 500. Use the arrows above to step through all ${fmt(S.hits.length)}.`;
      frag.append(li);
    }
    list.append(frag);
    renderHitMarks();
  }

  // Match positions on the progress bar, at most one mark per pixel.
  function renderHitMarks() {
    const marks = $('hitMarks');
    const w = Math.max(200, $('scrub').clientWidth);
    const seen = new Set();
    const mf = document.createDocumentFragment();
    for (const h of S.hits) {
      const pct = h / Math.max(1, S.words.length - 1);
      const px = Math.round(pct * w);
      if (seen.has(px)) continue;
      seen.add(px);
      const m = document.createElement('i');
      m.style.left = pct * 100 + '%';
      mf.append(m);
    }
    marks.replaceChildren(mf);
  }

  function clearSearch() {
    S.hits = []; S.hitQuery = ''; S.hitCur = -1;
    if (!$('results').hidden) closePanels();
    $('hitMarks').replaceChildren();
  }

  // ---------------------------------------------------------------- panels: results, contents, bookmarks

  // Brings a list item into view by scrolling the list only. scrollIntoView
  // would scroll the whole page too, pulling the word off screen.
  function scrollWithin(list, el) {
    const top = el.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
  }

  function openPanel(name) {
    for (const p of ['results', 'contentsPanel', 'bookmarksPanel']) $(p).hidden = p !== name;
    $('contentsBtn').setAttribute('aria-expanded', name === 'contentsPanel');
    $('bookmarksBtn').setAttribute('aria-expanded', name === 'bookmarksPanel');
  }
  function closePanels() { openPanel(null); }

  function renderContents() {
    const list = $('contentsList');
    const frag = document.createDocumentFragment();
    S.sections.forEach((s, k) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.s = k;
      b.style.paddingLeft = (0.75 + (s.level - 1) * 1.1) + 'rem';
      const t = document.createElement('span');
      t.className = 'grow';
      t.textContent = s.title;
      const pg = document.createElement('span');
      pg.className = 'pg';
      pg.textContent = placeLabel(s.idx);
      b.append(t, pg);
      li.append(b);
      frag.append(li);
    });
    list.replaceChildren(frag);
    markCurrentSection();
  }
  function markCurrentSection() {
    const list = $('contentsList');
    list.querySelectorAll('button.on').forEach(b => b.classList.remove('on'));
    const b = list.querySelector(`button[data-s="${sectionAt(S.idx)}"]`);
    if (b) { b.classList.add('on'); scrollWithin(list, b); }
  }

  function updateBookmarkCount() {
    $('bookmarksBtn').textContent = S.bookmarks.length ? `Bookmarks (${S.bookmarks.length})` : 'Bookmarks';
    $('markBtn').setAttribute('aria-pressed', S.bookmarks.includes(S.idx));
  }
  function saveBookmarks() {
    store.set('bm:' + S.key, S.bookmarks);
    updateBookmarkCount();
    if (!$('bookmarksPanel').hidden) renderBookmarks();
    if (!S.playing) renderContext();
  }
  function toggleBookmark() {
    if (!S.words.length) return;
    const i = S.idx;
    if (S.bookmarks.includes(i)) {
      S.bookmarks = S.bookmarks.filter(b => b !== i);
      Sync.removeBookmark(S.key, i);
      toast('Bookmark removed', 1500);
    } else {
      S.bookmarks = [...S.bookmarks, i].sort((a, b) => a - b);
      Sync.addBookmark(S.key, i);
      toast(`Bookmarked ${where(i)}`, 1500);
    }
    saveBookmarks();
  }
  function renderBookmarks() {
    const list = $('bookmarksList');
    const frag = document.createDocumentFragment();
    if (!S.bookmarks.length) {
      const li = document.createElement('li');
      li.className = 'more';
      li.textContent = 'No bookmarks yet. Press B while reading, or the bookmark button, to mark the current word.';
      frag.append(li);
    }
    for (const i of S.bookmarks) {
      const li = document.createElement('li');
      li.className = 'row';
      const b = document.createElement('button');
      b.dataset.i = i;
      const pg = document.createElement('span');
      pg.className = 'pg';
      pg.textContent = placeLabel(i);
      b.append(pg, snippet(i, 1));
      const x = document.createElement('button');
      x.className = 'x';
      x.dataset.del = i;
      x.title = 'Remove bookmark';
      x.setAttribute('aria-label', 'Remove bookmark');
      x.textContent = '\u00D7';
      li.append(b, x);
      frag.append(li);
    }
    list.replaceChildren(frag);
  }

  // ---------------------------------------------------------------- page jump

  function goPage(p) {
    if (!S.hasPages) return;
    if (!Number.isInteger(p) || p < 1 || p > S.pageCount) {
      toast(`Enter a ${S.pageLabel.toLowerCase()} number from 1 to ${fmt(S.pageCount)}.`);
      return;
    }
    const i = S.pageStart[p];
    jump(i);
    if (S.page[i] !== p) toast(`${S.pageLabel} ${p} has no text, so this is ${S.pageLabel.toLowerCase()} ${S.page[i]}.`);
  }

  // ---------------------------------------------------------------- views: start screen and reader

  function showReader() {
    $('empty').hidden = true;
    $('reader').hidden = false;
    $('homeBtn').hidden = false;
  }

  function goHome() {
    if (S.playing) pause();
    savePos();
    Sync.flush();
    setFocus(false);
    $('reader').hidden = true;
    $('empty').hidden = false;
    $('homeBtn').hidden = true;
    $('docTitle').textContent = '';
    document.title = 'Max\'s Speed Reader';
    renderLibrary();
  }

  function ago(t) {
    const d = new Date(t), now = new Date();
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  let libraryRun = 0;
  async function renderLibrary() {
    const run = ++libraryRun;
    const local = await lib.all();
    const remote = await Sync.listDocs();
    if (run !== libraryRun) return;
    const items = local.map(d => ({ key: d.key, title: d.title, format: d.format, words: d.words, at: d.openedAt, pos: getPos(d.key).i, remote: false }));
    for (const r of remote || []) {
      const mine = items.find(x => x.key === r.doc_key);
      if (mine) { if (Date.parse(r.position_at) > getPos(r.doc_key).t) mine.pos = r.position; continue; }
      if (r.has_content) items.push({ key: r.doc_key, title: r.title, format: r.format, words: r.word_count, at: Date.parse(r.opened_at), pos: r.position, remote: true });
    }
    items.sort((a, b) => b.at - a.at);
    $('library').hidden = !items.length;
    const frag = document.createDocumentFragment();
    for (const d of items) {
      const li = document.createElement('li');
      li.className = 'row';
      const b = document.createElement('button');
      b.dataset.key = d.key;
      if (d.remote) b.dataset.remote = '1';
      const t = document.createElement('span');
      t.className = 'lib-title';
      t.textContent = d.title;
      const meta = document.createElement('span');
      meta.className = 'lib-meta';
      const pct = d.words > 1 ? Math.min(100, Math.floor(d.pos / (d.words - 1) * 100)) : 0;
      meta.textContent = `${d.format ? d.format + ' \u00B7 ' : ''}${pct >= 99 ? 'Finished' : pct + '% read'} \u00B7 ${fmt(d.words)} words \u00B7 opened ${ago(d.at)}${d.remote ? ' \u00B7 from another device' : ''}`;
      const bar = document.createElement('span');
      bar.className = 'lib-bar';
      bar.style.setProperty('--p', pct + '%');
      b.append(t, meta, bar);
      const x = document.createElement('button');
      x.className = 'x';
      x.dataset.del = d.key;
      x.title = 'Remove from the library';
      x.setAttribute('aria-label', `Remove ${d.title}`);
      x.textContent = '\u00D7';
      li.append(b, x);
      frag.append(li);
    }
    $('libraryList').replaceChildren(frag);
  }

  async function openFromLibrary(key, remote) {
    if (key === S.key && S.words.length) { showReader(); $('docTitle').textContent = S.title; show(S.idx); setHint(); return; }
    const rec = await lib.get(key);
    if (rec) { try { load(rec.data, key); } catch (err) { toast(err.message); } return; }
    if (!remote) { toast('That document is no longer stored here. Open the file again.'); renderLibrary(); return; }
    showLoading('Downloading from your account');
    try {
      const data = await Sync.downloadDoc(key);
      if (!data) throw new Error('That document could not be downloaded.');
      load(data, key);
    } catch (err) {
      toast(err.message || 'That document could not be downloaded.', 6000);
    } finally { hideLoading(); }
  }

  async function removeFromLibrary(key) {
    const signedIn = !!Sync.user;
    if (signedIn && !confirm('Remove this document from your library on every device? Your place and bookmarks in it go too.')) return;
    await lib.del(key);
    store.del('pos:' + key);
    store.del('bm:' + key);
    if (signedIn) await Sync.deleteDoc(key);
    if (key === S.key) { S.key = ''; S.words = []; S.doc = null; }
    renderLibrary();
  }

  // ---------------------------------------------------------------- focus mode

  function setFocus(on) {
    if (on === document.body.classList.contains('focus')) return;
    document.body.classList.toggle('focus', on);
    $('focusBtn').setAttribute('aria-pressed', on);
    try {
      if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch { /* fullscreen is optional */ }
    if (S.words.length) show(S.idx);
  }

  // ---------------------------------------------------------------- settings UI

  let settingsTimer = 0;
  function saveSettings() {
    store.set('settings', set);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => Sync.pushSettings(set), 1500);
  }

  function applySettings() {
    const root = document.documentElement;
    if (set.theme === 'auto') root.removeAttribute('data-theme'); else root.dataset.theme = set.theme;
    const f = FONTS[set.font] || FONTS.atkinson;
    if (f.css && !document.querySelector(`link[data-font="${set.font}"]`)) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.dataset.font = set.font;
      l.href = `https://fonts.googleapis.com/css2?family=${f.css}&display=swap`;
      document.head.append(l);
      // Re-fit the word once the new font's letters (and widths) arrive.
      document.fonts.ready.then(() => { if (S.words.length) show(S.idx); });
    }
    root.style.setProperty('--word-font', f.family);
    root.style.setProperty('--focal-use', FOCAL[set.focal] || FOCAL.red);
    root.style.setProperty('--word-scale', set.size);
    document.body.classList.toggle('noguides', !set.guides);
    for (const seg of document.querySelectorAll('.seg[data-setting]')) {
      for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(set[seg.dataset.setting]) === b.dataset.v);
    }
    for (const cb of document.querySelectorAll('input[type=checkbox][data-setting]')) cb.checked = !!set[cb.dataset.setting];
    $('sizeRange').value = set.size;
    $('wpmRange').value = set.wpm;
    $('wpmNum').value = set.wpm;
    if (S.words.length) {
      computeWeights();
      show(S.idx);
    }
  }

  function changeSetting(k, v) {
    set[k] = v;
    saveSettings();
    applySettings();
  }

  // ---------------------------------------------------------------- opening files

  function showLoading(msg) { $('loading').hidden = false; $('loadingText').textContent = msg; }
  function hideLoading() { $('loading').hidden = true; }

  let toastTimer = 0;
  function toast(msg, ms = 4500) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // A document is identified by a hash of its contents, so the same file
  // matches across devices (for sync) and across renames. Where hashing isn't
  // available (a page served over plain http from another machine), name,
  // size and date stand in.
  async function hashKey(bytes, fallback) {
    try {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(d.slice(0, 16), x => x.toString(16).padStart(2, '0')).join('');
    } catch { return fallback; }
  }

  // Only the most recent open counts: dropping a second file while the first
  // is still loading, or pressing Cancel, abandons the first.
  let loading = null;
  function cancelLoading() {
    if (!loading) return;
    loading.abort();
    loading = null;
    hideLoading();
  }

  async function openFile(file) {
    if (!file) return;
    if (S.playing) pause();
    cancelLoading();
    const ctl = loading = new AbortController();
    showLoading('Opening ' + file.name);
    try {
      const key = await hashKey(await file.arrayBuffer(), `${file.name}|${file.size}|${file.lastModified}`);
      const r = await window.SRExtract.fromFile(file, msg => { $('loadingText').textContent = msg; }, ctl.signal);
      if (ctl.signal.aborted) return;
      load(r, key);
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.error(err);
      toast(err && err.message ? err.message : 'This file could not be read.', 8000);
    } finally {
      if (loading === ctl) { loading = null; hideLoading(); }
    }
  }

  async function openText(text) {
    if (!text.trim()) { toast('Paste some text first.'); return; }
    if (S.playing) pause();
    cancelLoading();
    try {
      const words = text.trim().split(/\s+/);
      const title = words.slice(0, 6).join(' ') + (words.length > 6 ? '\u2026' : '');
      const key = await hashKey(new TextEncoder().encode(text), 'paste|' + text.length);
      load(window.SRExtract.fromText(text, title), key);
    } catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------------------- sync (Supabase)

  // When a document opens: keep its text in your account so other devices can
  // open it, and if another device read further more recently, go there.
  async function syncOpened(key, localPos) {
    if (!Sync.user || !S.doc) return;
    const startIdx = S.idx;
    const remote = await Sync.getDoc(key);
    if (S.key !== key) return;
    // Chapters found by AI on one device are shared with the others.
    const local = store.get('ai:' + key, null);
    if (remote && remote.structure && !local) { store.set('ai:' + key, remote.structure); applyStructure(remote.structure, false); }
    await Sync.saveDoc({ key, title: S.title, format: S.doc.format || '', words: S.words.length, pageLabel: S.pageLabel, pageCount: S.pageCount }, S.doc, remote);
    if (local && !(remote && remote.structure)) Sync.saveStructure(key, local);
    if (remote && remote.position > 0 && remote.position < S.words.length && remote.position !== S.idx
        && Date.parse(remote.position_at) > localPos.t && !S.playing && S.idx === startIdx && S.key === key) {
      jump(remote.position);
      savePos();
      toast(`Picked up where you left off on another device, ${where(remote.position)}.`);
    }
    const marks = await Sync.listBookmarks(key);
    if (S.key !== key || !marks) return;
    for (const i of S.bookmarks) if (!marks.includes(i)) Sync.addBookmark(key, i);
    const merged = [...new Set([...S.bookmarks, ...marks])].filter(i => i < S.words.length).sort((a, b) => a - b);
    if (merged.length !== S.bookmarks.length) { S.bookmarks = merged; saveBookmarks(); }
  }

  async function onSignedIn() {
    const remote = await Sync.pullSettings();
    if (remote && remote.settings) {
      set = { ...DEFAULTS, ...remote.settings };
      store.set('settings', set);
      applySettings();
    } else Sync.pushSettings(set);
    if (S.words.length) await syncOpened(S.key, getPos(S.key));
    if (!$('empty').hidden) renderLibrary();
  }

  function renderAccount(status, message) {
    const btn = $('accountBtn');
    if (status === 'off') { btn.hidden = true; return; }
    btn.hidden = false;
    btn.dataset.status = status;
    const u = Sync.user;
    $('accountLabel').textContent = u ? (u.email || 'Account') : 'Sign in to sync';
    btn.title = status === 'error' ? 'Sync problem: ' + message : status === 'syncing' ? 'Syncing' : u ? 'Synced' : 'Sync your library across devices';
    $('acctOut').hidden = !!u;
    $('acctIn').hidden = !u;
    if (u) {
      $('acctEmail').textContent = u.email || 'your account';
      $('acctStatus').textContent = status === 'error' ? `Sync problem: ${message}. Your reading is still saved in this browser.`
        : status === 'syncing' ? 'Syncing\u2026' : 'Everything is synced.';
    }
  }

  function wireAccount() {
    const panel = $('accountPanel');
    $('accountBtn').onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !Sync.user) $('acctEmailInput').focus();
    };
    document.addEventListener('click', e => {
      if (!panel.hidden && !panel.contains(e.target) && !$('accountBtn').contains(e.target)) panel.hidden = true;
    });
    // Only offer the sign-in methods the Supabase project has switched on.
    let checked = false;
    const offerMethods = async () => {
      if (checked) return;
      checked = true;
      const m = await Sync.providers();
      $('acctGoogleWrap').hidden = m.google === false;
      $('acctForm').hidden = m.email === false;
      $('acctOr').hidden = m.google === false || m.email === false;
    };
    $('acctGoogle').onclick = async () => {
      $('acctError').textContent = '';
      try { await Sync.signInWithGoogle(); }
      catch (err) { $('acctError').textContent = err.message || 'Google sign-in didn\'t start.'; }
    };
    $('accountBtn').addEventListener('click', offerMethods);
    let email = '';
    const restart = () => {
      $('acctForm').hidden = false; $('acctCodeForm').hidden = true;
      $('acctError').textContent = ''; $('acctCode').value = '';
    };
    $('acctForm').onsubmit = async e => {
      e.preventDefault();
      email = $('acctEmailInput').value.trim();
      if (!email) return;
      const btn = $('acctSend');
      btn.disabled = true;
      $('acctError').textContent = '';
      try {
        await Sync.sendLink(email);
        $('acctSentTo').textContent = email;
        $('acctForm').hidden = true;
        $('acctCodeForm').hidden = false;
        $('acctCode').focus();
      } catch (err) { $('acctError').textContent = err.message || 'The email could not be sent.'; }
      finally { btn.disabled = false; }
    };
    $('acctCodeForm').onsubmit = async e => {
      e.preventDefault();
      $('acctError').textContent = '';
      try {
        await Sync.verifyCode(email, $('acctCode').value.replace(/\s/g, ''));
        panel.hidden = true;
        restart();
        toast('Signed in. Your library, places and bookmarks now sync.');
      } catch (err) { $('acctError').textContent = err.message || 'That code didn\'t work.'; }
    };
    $('acctRestart').onclick = restart;
    $('acctSignOut').onclick = async () => {
      await Sync.signOut();
      panel.hidden = true;
      restart();
      toast('Signed out. Everything stays in this browser.');
      if (!$('empty').hidden) renderLibrary();
    };
  }

  // ---------------------------------------------------------------- wiring

  function wire() {
    const fileInput = $('fileInput');
    const pick = () => fileInput.click();
    $('openBtn').onclick = pick;
    $('chooseBtn').onclick = pick;
    $('homeBtn').onclick = goHome;
    fileInput.onchange = () => { openFile(fileInput.files[0]); fileInput.value = ''; };
    $('pasteGo').onclick = () => openText($('pasteBox').value);

    $('libraryList').addEventListener('click', e => {
      const del = e.target.closest('button[data-del]');
      if (del) { removeFromLibrary(del.dataset.del); return; }
      const b = e.target.closest('button[data-key]');
      if (b) openFromLibrary(b.dataset.key, b.dataset.remote === '1');
    });

    // Files, or text dragged in from another app, open as a document. A word
    // dragged around inside this page (from the text panel, say) is ignored,
    // and text dropped into the search box just goes into the search box.
    let depth = 0, internal = false;
    const intoField = e => /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && !(e.dataTransfer && e.dataTransfer.types.includes('Files'));
    document.addEventListener('dragstart', () => { internal = true; });
    document.addEventListener('dragend', () => { internal = false; });
    document.addEventListener('dragenter', e => {
      if (internal) return;
      e.preventDefault();
      depth++;
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', () => {
      if (internal) return;
      if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); }
    });
    document.addEventListener('dragover', e => { if (!internal && !intoField(e)) e.preventDefault(); });
    document.addEventListener('drop', e => {
      depth = 0;
      document.body.classList.remove('dragging');
      if (internal || intoField(e)) return;
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) openFile(f);
      else {
        const t = e.dataTransfer && e.dataTransfer.getData('text/plain');
        if (t) openText(t);
      }
    });
    $('cancelLoad').onclick = cancelLoading;

    $('playBtn').onclick = toggle;
    $('stage').onclick = toggle;
    $('backBtn').onclick = () => skipTime(-10);
    $('fwdBtn').onclick = () => skipTime(10);
    $('markBtn').onclick = toggleBookmark;
    $('focusBtn').onclick = () => setFocus(!document.body.classList.contains('focus'));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && document.body.classList.contains('focus')) setFocus(false);
    });

    $('wpmRange').oninput = e => setWpm(+e.target.value);
    $('wpmNum').onchange = e => setWpm(+e.target.value);

    // Settings: segmented buttons, checkboxes and the size slider all write
    // straight into `set`.
    for (const seg of document.querySelectorAll('.seg[data-setting]')) {
      seg.addEventListener('click', e => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        const k = seg.dataset.setting;
        changeSetting(k, typeof DEFAULTS[k] === 'number' ? +b.dataset.v : b.dataset.v);
      });
    }
    for (const cb of document.querySelectorAll('input[type=checkbox][data-setting]')) {
      cb.addEventListener('change', () => changeSetting(cb.dataset.setting, cb.checked));
    }
    $('sizeRange').oninput = e => changeSetting('size', clamp(+e.target.value || 1, 0.6, 1.8));
    $('resetSettings').onclick = () => { set = { ...DEFAULTS, wpm: set.wpm }; saveSettings(); applySettings(); };
    const details = $('settingsPanel');
    details.open = store.get('settingsOpen', false);
    details.addEventListener('toggle', () => store.set('settingsOpen', details.open));

    let typingTimer = 0;
    $('searchInput').addEventListener('input', e => {
      clearTimeout(typingTimer);
      const q = e.target.value;
      if (!q.trim()) { clearSearch(); return; }
      typingTimer = setTimeout(() => search(q, false), 200);
    });
    $('searchForm').onsubmit = e => {
      e.preventDefault();
      clearTimeout(typingTimer);
      const q = $('searchInput').value;
      if (q.trim() && q.trim() === S.hitQuery) stepHit(1);
      else search(q, true);
    };
    $('resPrev').onclick = () => stepHit(-1);
    $('resNext').onclick = () => stepHit(1);
    $('resClose').onclick = () => { clearSearch(); $('searchInput').value = ''; };
    $('resList').addEventListener('click', e => {
      const b = e.target.closest('button[data-k]');
      if (b) goHit(+b.dataset.k);
    });

    $('contentsBtn').onclick = () => {
      if ($('contentsPanel').hidden) { renderContents(); openPanel('contentsPanel'); markCurrentSection(); } else closePanels();
    };
    $('contentsList').addEventListener('click', e => {
      const b = e.target.closest('button[data-s]');
      if (b) { if (S.playing) pause(); jump(S.sections[+b.dataset.s].idx); markCurrentSection(); }
    });
    $('bookmarksBtn').onclick = () => {
      if ($('bookmarksPanel').hidden) { renderBookmarks(); openPanel('bookmarksPanel'); } else closePanels();
    };
    $('bookmarksList').addEventListener('click', e => {
      const del = e.target.closest('button[data-del]');
      if (del) {
        const i = +del.dataset.del;
        S.bookmarks = S.bookmarks.filter(b => b !== i);
        Sync.removeBookmark(S.key, i);
        saveBookmarks();
        return;
      }
      const b = e.target.closest('button[data-i]');
      if (b) { if (S.playing) pause(); jump(+b.dataset.i); }
    });
    for (const id of ['contentsClose', 'bookmarksClose']) $(id).onclick = closePanels;
    $('prevSecBtn').onclick = () => stepSection(-1);
    $('nextSecBtn').onclick = () => stepSection(1);
    $('skipBtn').onclick = () => { if (S.playing) pause(); jump(S.bodyStart); };
    $('aiBtn').onclick = () => runAI(false);
    $('useFileContents').onclick = () => {
      store.del('ai:' + S.key);
      Sync.saveStructure(S.key, null);
      S.sections = S.fileSections; S.sectionsFrom = S.fileSections.length >= 2 ? 'file' : 'none'; S.bodyStart = 0; S.secCur = -2;
      refreshStructureUI(); updateMeta(); renderContents();
    };
    // Gemini key: kept only in this browser.
    const showKey = () => {
      const has = window.SRAI.hasKey();
      $('aiKey').value = '';
      $('aiKey').placeholder = has ? 'Key saved in this browser' : 'Paste a Gemini API key';
      $('aiKeyRemove').hidden = !has;
    };
    $('aiKeyForm').onsubmit = e => {
      e.preventDefault();
      const k = $('aiKey').value.trim();
      if (!k) return;
      window.SRAI.setKey(k);
      showKey();
      toast('Gemini key saved in this browser.');
      if (S.words.length && S.sectionsFrom !== 'file' && !store.get('ai:' + S.key, null)) runAI(false);
    };
    $('aiKeyRemove').onclick = () => { window.SRAI.setKey(''); showKey(); toast('Gemini key removed.'); };
    showKey();

    $('pageForm').onsubmit = e => { e.preventDefault(); goPage(parseInt($('pageInput').value, 10)); };

    $('contextText').addEventListener('click', e => {
      const sp = e.target.closest('span[data-i]');
      if (sp) jump(+sp.dataset.i);
    });

    wireScrub();
    wireAccount();

    // Shortcuts work everywhere except while typing. Sliders keep their own
    // arrow keys, a keyboard-focused checkbox keeps Space.
    const typing = el => el.tagName === 'TEXTAREA' || el.isContentEditable ||
      (el.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'submit'].includes(el.type));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (loading) { cancelLoading(); return; }
        if (!$('accountPanel').hidden) { $('accountPanel').hidden = true; return; }
        if (document.body.classList.contains('focus')) { setFocus(false); return; }
      }
      if (!S.words.length || $('reader').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(e.target)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.target.type === 'range' && e.key.startsWith('Arrow')) return;
      if (e.target.type === 'checkbox' && e.key === ' ') return;
      switch (e.key) {
        case ' ': e.preventDefault(); toggle(); break;
        case 'ArrowLeft': e.preventDefault(); e.shiftKey ? jump(S.idx - 1) : backSentence(); break;
        case 'ArrowRight': e.preventDefault(); e.shiftKey ? jump(S.idx + 1) : fwdSentence(); break;
        case 'ArrowUp': e.preventDefault(); setWpm(set.wpm + 25); toast(`${set.wpm} words per minute`, 1200); break;
        case 'ArrowDown': e.preventDefault(); setWpm(set.wpm - 25); toast(`${set.wpm} words per minute`, 1200); break;
        case 'PageUp': e.preventDefault(); stepPage(-1); break;
        case 'PageDown': e.preventDefault(); stepPage(1); break;
        case '[': stepSection(-1); break;
        case ']': stepSection(1); break;
        case 'b': case 'B': toggleBookmark(); break;
        case 'f': case 'F': setFocus(!document.body.classList.contains('focus')); break;
        case 's': case 'S': if (S.bodyStart && S.idx < S.bodyStart) { jump(S.bodyStart); toast('Skipped to the main text', 1500); } break;
        case 'Escape': closePanels(); break;
        case 'Home': e.preventDefault(); jump(0); break;
        case '/': e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); break;
        default:
      }
    });
    // A mouse click leaves focus on the button, slider or checkbox, and Space
    // would then act on that control instead of playing. Keyboard focus
    // (Tab) is left alone.
    document.addEventListener('pointerup', e => {
      if (!e.target.closest('button, input[type=range], input[type=checkbox], label, summary')) return;
      setTimeout(() => { const a = document.activeElement; if (a && a !== document.body && !typing(a)) a.blur(); }, 0);
    });
    window.addEventListener('pagehide', () => { savePos(); Sync.flush(); });
    // Background tabs slow timers to a crawl, so reading on there is useless.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (S.playing) pause(); savePos(); Sync.flush(); }
    });
    window.addEventListener('resize', () => { if (S.words.length) { show(S.idx); if (S.hits.length) renderHitMarks(); } });
  }

  wire();
  applySettings();
  renderLibrary();
  Sync.init(user => { if (user) onSignedIn().catch(err => console.error(err)); else if (!$('empty').hidden) renderLibrary(); },
    renderAccount, msg => toast(msg, 7000));
  window.SR = { S, get set() { return set; }, load, openFile, openText, splitWord }; // for debugging in the console
})();
