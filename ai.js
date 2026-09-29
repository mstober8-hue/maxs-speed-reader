// Finds where a document's real text starts and where its chapters are, using
// Google's Gemini API with the reader's own (free) API key. Used for files that
// don't carry their own table of contents: plain text, many PDFs, scans.
//
// The model is never trusted with positions. The text goes out with markers
// like [@1200] every 50 words; the model answers with the nearest marker and
// the first few words at each place, and those words are then looked up in
// the actual text near that marker. Anything that can't be found there is
// dropped rather than guessed, so a made-up chapter never appears.
//
// The key lives only in this browser's localStorage and is sent only to
// generativelanguage.googleapis.com, straight from the page.
(function () {
  'use strict';

  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const CHUNK = 60000;  // words per request, about 80k tokens
  const MARK = 50;      // a position marker every this many words

  const KEY_NAME = 'sr:geminiKey';
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; } };
  const setKey = k => { try { if (k) localStorage.setItem(KEY_NAME, k); else localStorage.removeItem(KEY_NAME); } catch { /* ignore */ } };

  const INSTRUCTIONS = `You help a speed-reading app let its reader skip around a document.

The document text follows. Markers like [@1200] have been inserted into it: the number is the position of the word right after the marker. Markers are not part of the document.

Find:
1. bodyStart: where the main text begins, after the front matter. Front matter is the title page, half title, copyright page, dedication, epigraph, table of contents, lists of figures or tables, "praise for" pages, "also by" pages and publisher's notes. A foreword, preface, prologue or introduction counts as main text. Return null if the main text starts right away, or if you were not given the beginning of the document.
2. sections: every chapter or major section heading that is actually in the text, in order. That includes parts, books, chapters, prologues, epilogues, appendices, and back matter such as notes, bibliography and index. Do not return the lines of a table of contents, which list headings without being them. Do not return running headers or page numbers.

For every place, give "near": the number of the closest marker before it, and "firstWords": the first 4 to 8 words at that place, copied exactly from the text, without markers. For each section also give "title", the heading as a reader would name it (for example "Chapter 3: The Storm"), and "level": 1 for a part or book, 2 for a chapter inside a part, and 1 for everything when there are no parts.

Only return places that are in the text. If there are no headings, return an empty list.`;

  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      bodyStart: {
        type: 'OBJECT', nullable: true,
        properties: { near: { type: 'INTEGER' }, firstWords: { type: 'STRING' } },
        required: ['near', 'firstWords'],
      },
      sections: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' }, level: { type: 'INTEGER' },
            near: { type: 'INTEGER' }, firstWords: { type: 'STRING' },
          },
          required: ['title', 'near', 'firstWords'],
        },
      },
    },
    required: ['sections'],
  };

  // ---------------------------------------------------------------- talking to the API

  class ApiError extends Error {
    constructor(message, status, retryMs, noQuota) { super(message); this.status = status; this.retryMs = retryMs; this.noQuota = noQuota; }
  }

  async function call(path, key, body, signal) {
    let res;
    try {
      res = await fetch(API + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'x-goog-api-key': key, 'Content-Type': 'application/json' } : { 'x-goog-api-key': key },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new ApiError('Could not reach Google\'s Gemini API. Check the internet connection.', 0);
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    const e = json.error || {};
    const msg = e.message || res.statusText;
    const retry = (e.details || []).find(d => /RetryInfo$/.test(d['@type'] || ''));
    const retryMs = retry && retry.retryDelay ? parseFloat(retry.retryDelay) * 1000 : 0;
    if (res.status === 400 && /API key|API_KEY/i.test(msg + JSON.stringify(e.details || '')) || res.status === 401 || res.status === 403) {
      throw new ApiError('Google did not accept that Gemini API key. Check it, or make a new one at aistudio.google.com/apikey.', res.status);
    }
    if (res.status === 429) {
      // "limit: 0" means this model isn't on the free tier at all for this key.
      throw new ApiError('Gemini\'s free limit is used up for now. Try again in a minute, or tomorrow if the daily limit is used up.', 429, retryMs, /limit:\s*0\b/.test(msg));
    }
    throw new ApiError(`Gemini returned an error: ${msg}`, res.status);
  }

  // The newest stable "flash" model the key can use, then fallbacks. Asking
  // the API instead of hard-coding a name means an old model being retired
  // doesn't break this.
  async function models(key, signal) {
    const list = await call('/models?pageSize=1000', key, null, signal);
    const names = (list.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
    const odd = /lite|image|tts|audio|live|embed|preview|exp|think|learnlm|gemma|nano|robot|computer|native/;
    const version = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    const stable = names.filter(n => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a, b) => version(b) - version(a));
    const other = names.filter(n => /flash/.test(n) && !odd.test(n) && !stable.includes(n)).sort((a, b) => version(b) - version(a));
    const lite = names.filter(n => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort((a, b) => version(b) - version(a));
    const out = [...stable, ...other, ...lite];
    if (!out.length) throw new ApiError('None of Gemini\'s text models are available to this key.', 404);
    return out;
  }

  async function ask(model, key, prompt, signal, schema = true) {
    const body = {
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', ...(schema ? { responseSchema: SCHEMA } : {}) },
    };
    let json;
    try {
      json = await call(`/models/${model}:generateContent`, key, body, signal);
    } catch (err) {
      // Some models reject a response schema; ask again for plain JSON.
      if (schema && err.status === 400 && /schema/i.test(err.message)) return ask(model, key, prompt, signal, false);
      throw err;
    }
    const cand = (json.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
    if (!text) throw new ApiError(`Gemini gave no answer for this part (${cand.finishReason || (json.promptFeedback || {}).blockReason || 'no reason given'}).`, 200);
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { throw new ApiError('Gemini\'s answer was not in the expected form.', 200); }
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

  // ---------------------------------------------------------------- finding the structure

  function withMarkers(words, para, a, b) {
    const out = [];
    for (let i = a; i < b; i++) {
      if ((i - a) % MARK === 0) out.push(`[@${i}]`);
      out.push(words[i] + (para[i] ? '\n\n' : ''));
    }
    return out.join(' ');
  }

  // The first words the model quoted, looked up close to the marker it named.
  // The closest match wins, so a heading repeated in a table of contents
  // earlier on doesn't pull the result back there.
  function locate(norm, normalize, near, firstWords, lo, hi) {
    const all = String(firstWords || '').replace(/\[@\d+\]/g, ' ').split(/\s+/).map(normalize).filter(Boolean);
    for (const len of [Math.min(6, all.length), Math.min(3, all.length)]) {
      if (!len) return -1;
      const want = all.slice(0, len);
      const a = Math.max(lo, near - MARK), b = Math.min(hi, near + MARK * 6);
      let best = -1;
      for (let i = a; i + len <= b; i++) {
        let ok = true;
        for (let j = 0; j < len && ok; j++) ok = norm[i + j] === want[j];
        if (ok && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  async function findStructure({ words, para, norm, normalize, title, onProgress = () => {}, signal }) {
    const key = getKey();
    if (!key) throw new ApiError('Add a Gemini API key in Settings first.', 0);
    const n = words.length;
    const parts = Math.max(1, Math.ceil(n / CHUNK));
    onProgress('Connecting to Gemini');
    let candidates = await models(key, signal);
    let model = candidates[0];

    let start = null;
    const sections = [];
    let dropped = 0;
    const failed = [];
    for (let p = 0; p < parts; p++) {
      const a = p * CHUNK, b = Math.min(n, a + CHUNK);
      onProgress(parts > 1 ? `Reading part ${p + 1} of ${parts} with Gemini` : 'Reading the document with Gemini');
      const head = `Document: "${title}". ${parts > 1 ? `This is part ${p + 1} of ${parts}, so it may begin or end in the middle of a chapter.${p > 0 ? ' It is not the beginning of the document, so bodyStart is null.' : ''}` : 'This is the whole document.'}\n\n`;
      let answer = null;
      for (let attempt = 0; attempt < 4 && !answer; attempt++) {
        try {
          answer = await ask(model, key, head + withMarkers(words, para, a, b), signal);
        } catch (err) {
          if (signal && signal.aborted) throw err;
          if (err.status === 429 && err.noQuota && candidates.length > 1) { candidates = candidates.slice(1); model = candidates[0]; continue; }
          if (err.status === 429 && attempt < 3) {
            const wait = Math.min(65000, err.retryMs || 20000 * (attempt + 1));
            onProgress(`Gemini asked to slow down; waiting ${Math.round(wait / 1000)} seconds`);
            await sleep(wait, signal);
            continue;
          }
          if (err.status === 200 || err.status >= 500) { failed.push(`part ${p + 1}: ${err.message}`); break; }
          throw err;
        }
      }
      if (!answer) continue;
      if (p === 0 && answer.bodyStart) {
        const i = locate(norm, normalize, +answer.bodyStart.near, answer.bodyStart.firstWords, a, b);
        if (i > 0) start = i; else if (i < 0) dropped++;
      }
      for (const s of answer.sections || []) {
        const i = locate(norm, normalize, +s.near, s.firstWords, a, b);
        const t = String(s.title || '').replace(/\s+/g, ' ').trim();
        if (i < 0 || !t) { dropped++; continue; }
        sections.push({ title: t.length > 90 ? t.slice(0, 88) + '\u2026' : t, level: Math.min(3, Math.max(1, +s.level || 1)), idx: i });
      }
    }
    sections.sort((x, y) => x.idx - y.idx);
    const unique = sections.filter((s, k) => k === 0 || s.idx - sections[k - 1].idx > 2);
    // If every section came back as level 2 (no parts), make them top level.
    const minLevel = Math.min(...unique.map(s => s.level), 3);
    for (const s of unique) s.level -= minLevel - 1;
    return { start, sections: unique, dropped, failed, model, at: Date.now() };
  }

  window.SRAI = { hasKey: () => !!getKey(), getKey, setKey, findStructure };
})();
