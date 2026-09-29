// Turns a dropped file into plain reading units: [{ text, page, soft, heading }].
//
//   page     1-based page (or slide, or sheet) the text sits on
//   soft     true when the unit ends mid-paragraph (a PDF page, a Word page
//            break), so the reader does not add a paragraph pause there
//   heading  1-3 when the unit is a heading, for the Contents list
//
// A result may also carry `outline`: [{ title, level, page } or { title,
// level, unit }], the file's own table of contents (PDF bookmarks, an EPUB's
// contents page, slide titles, sheet names). When present it is used for
// Contents instead of the headings.
//
// The format is detected from the file's first bytes, not its extension, so a
// renamed .docx or a PDF saved without an extension still opens. Page numbers
// are only reported when the format actually records them (PDF pages, slides,
// sheets, Word's last-rendered page breaks, LibreOffice's soft page breaks,
// form feeds in plain text). Everything else has pagesReal = false and no page
// numbers at all; they are never estimated.
(function () {
  'use strict';

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  const LEGACY = {
    doc: 'Old Word files (.doc) can\'t be read here. Open it in Word or Pages and save it as .docx or PDF.',
    ppt: 'Old PowerPoint files (.ppt) can\'t be read here. Save it as .pptx or PDF first.',
    xls: 'Old Excel files (.xls) can\'t be read here. Save it as .xlsx first.',
  };

  const extOf = name => ((name || '').match(/\.([^./]+)$/) || [, ''])[1].toLowerCase();

  async function fromFile(file, progress = () => {}, signal = null) {
    const ext = extOf(file.name);
    const step = msg => { if (signal) signal.throwIfAborted(); progress(msg); };
    const buf = await file.arrayBuffer();
    const b = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
    const starts = s => s.split('').every((ch, i) => b[i] === ch.charCodeAt(0));
    let r;

    if (starts('%PDF')) r = await pdf(buf, step, signal);
    else if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) r = await zipped(buf, step);
    else if (starts('{\\rtf')) r = rtf(buf);
    else if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
      throw new Error(LEGACY[ext] || 'This is an old Microsoft Office file (.doc, .ppt or .xls). Save it as .docx, .pptx or PDF and open that instead.');
    } else if (isImage(b, file.type)) r = await image(file, step, signal);
    else {
      const text = decodeText(buf);
      if (looksBinary(text)) throw new Error(`The reader doesn't know how to read ${ext ? '.' + ext + ' files' : 'this file'}. Try saving it as PDF, .docx or plain text.`);
      const head = text.slice(0, 2000).toLowerCase();
      if (ext === 'svg' || (/<svg[\s>]/.test(head) && !/<html[\s>]/.test(head))) r = svgDoc(text);
      else if (['html', 'htm', 'xhtml', 'xht'].includes(ext) || /<!doctype html|<html[\s>]/.test(head)) r = htmlDoc(text);
      else r = plain(text, ext);
    }
    r.title = file.name.replace(/\.[^.]+$/, '') || file.name;
    r.format = ext ? ext.toUpperCase() : 'File';
    return r;
  }

  function fromText(text, title = 'Pasted text') {
    const r = plain(text, 'txt');
    r.title = title;
    r.format = 'Pasted';
    return r;
  }

  // ---------------------------------------------------------------- helpers

  // SVG is text, not pixels, so it goes to the HTML reader instead.
  function isImage(b, type) {
    if ((type || '').startsWith('image/') && type !== 'image/svg+xml') return true;
    const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const gif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
    const bmp = b[0] === 0x42 && b[1] === 0x4d;
    const webp = b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45;
    return png || jpg || gif || bmp || webp;
  }

  function decodeText(buf) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
    const s = new TextDecoder('utf-8').decode(b);
    const bad = (s.match(/\uFFFD/g) || []).length;
    return bad > s.length * 0.01 ? new TextDecoder('windows-1252').decode(b) : s;
  }

  function looksBinary(s) {
    const sample = s.slice(0, 20000);
    if (!sample.length) return false;
    const bad = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
    return bad > sample.length * 0.02;
  }

  const parseXml = s => new DOMParser().parseFromString(s, 'application/xml');
  const byLocal = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));
  const attr = (el, local) => {
    for (const a of el.attributes) if (a.localName === local) return a.value;
    return null;
  };
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  function resolvePath(base, href) {
    const out = [];
    for (const p of (base ? base.split('/') : []).concat(href.split('#')[0].split('/'))) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/');
  }

  async function readRels(zip, relsPath, baseDir) {
    const f = zip.file(relsPath);
    const map = {};
    if (!f) return map;
    for (const rel of byLocal(parseXml(await f.async('string')), 'Relationship')) {
      const target = rel.getAttribute('Target') || '';
      map[rel.getAttribute('Id')] = target.startsWith('/') ? target.slice(1) : resolvePath(baseDir, target);
    }
    return map;
  }

  // Collects paragraphs as they are walked. brk() starts a new page; when it
  // lands mid-paragraph the half before it is marked soft.
  function collector() {
    const units = [];
    let cur = '', page = 1;
    return {
      units,
      add(s) { cur += s; },
      flush(soft = false, heading = 0) {
        const text = cur.replace(/\s+/g, ' ').trim();
        if (text) units.push(heading ? { text, page, soft, heading } : { text, page, soft });
        cur = '';
      },
      brk() { this.flush(true); page++; },
      setPage(p) { this.flush(true); page = p; },
      get page() { return page; },
    };
  }

  // Libraries are loaded the first time a file needs them, so opening the
  // page stays light: pdf.js alone is 1.3 MB.
  const loaded = {};
  function loadScript(src, failure) {
    loaded[src] = loaded[src] || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { loaded[src] = null; s.remove(); reject(new Error(failure)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  const needPdf = () => loadScript('vendor/pdf.min.js', 'The PDF reader (vendor/pdf.min.js) could not be loaded. Check that the vendor folder is next to index.html.');
  const needZip = () => loadScript('vendor/jszip.min.js', 'The document reader (vendor/jszip.min.js) could not be loaded. Check that the vendor folder is next to index.html.');

  async function recognize(sources, progress, signal) {
    await loadScript(TESSERACT_URL, 'Text recognition needs an internet connection to load the first time. Check the connection and try again.');
    progress('Loading text recognition');
    let worker;
    try {
      worker = await window.Tesseract.createWorker('eng');
    } catch {
      throw new Error('Text recognition could not start. It needs an internet connection the first time.');
    }
    // Cancelling stops the worker mid-page instead of waiting it out. A
    // stopped worker never settles its current job, so the wait is raced
    // against the cancel itself.
    let stop;
    const cancelled = new Promise((_, reject) => {
      stop = () => { worker.terminate(); reject(signal.reason); };
    });
    cancelled.catch(() => {});
    if (signal) signal.addEventListener('abort', stop);
    try {
      const out = [];
      for (let i = 0; i < sources.length; i++) {
        if (signal) signal.throwIfAborted();
        progress(sources.length > 1 ? `Recognizing text: ${i + 1} of ${sources.length}` : 'Recognizing text');
        const { data } = await Promise.race([worker.recognize(await sources[i]()), cancelled]);
        out.push(data.text || '');
      }
      return out;
    } finally {
      if (signal) signal.removeEventListener('abort', stop);
      if (!signal || !signal.aborted) await worker.terminate();
    }
  }

  // A hyphen at the end of a line is either typesetting ("extra- / ordinary")
  // or part of a real compound ("well- / known"). The rest of the document
  // usually settles which: if the word appears elsewhere unbroken, join it;
  // if it appears with its hyphen, keep it. Unknown ones are joined, since
  // justified text breaks words far more often than it breaks compounds.
  const LINE_HYPHEN = '\u0001';
  const markHyphens = s => s.replace(/(\p{Ll})-[ \t]*\n\s*(\p{Ll})/gu, '$1' + LINE_HYPHEN + '$2');
  function resolveHyphens(units) {
    const seen = new Set();
    const key = w => w.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    for (const u of units) for (const w of u.text.split(' ')) if (!w.includes(LINE_HYPHEN)) seen.add(key(w));
    for (const u of units) {
      if (!u.text.includes(LINE_HYPHEN)) continue;
      u.text = u.text.replace(/\S*\u0001\S*/g, w => {
        const joined = w.split(LINE_HYPHEN).join('');
        const hyph = w.split(LINE_HYPHEN).join('-');
        return !seen.has(key(joined)) && seen.has(key(hyph)) ? hyph : joined;
      });
    }
    return units;
  }

  // ---------------------------------------------------------------- PDF

  async function pdf(buf, progress, signal) {
    await needPdf();
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    let doc;
    try {
      doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password (or print it to a new PDF) and open that.');
      throw new Error('This PDF could not be opened. It may be damaged.');
    }
    try {
      return await pdfRead(doc, progress, signal);
    } finally {
      doc.destroy();
    }
  }

  async function pdfRead(doc, progress, signal) {
    const lib = window.pdfjsLib;
    const n = doc.numPages;
    const units = [];
    const scanned = [];
    const O = lib.OPS;
    const imageOps = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject].filter(v => v !== undefined));

    const pages = [];
    for (let p = 1; p <= n; p++) {
      progress(`Reading page ${p} of ${n}`);
      const page = await doc.getPage(p);
      const [, y0, , y1] = page.view;
      const lines = pdfLines((await page.getTextContent()).items);
      // Only the two highest and two lowest lines on the page, and only if
      // they sit in the outer tenth of it, can be a header or footer.
      const ys = [...new Set(lines.map(l => l.y))].sort((a, b) => a - b);
      const outer = new Set([...ys.slice(0, 2), ...ys.slice(-2)]);
      for (const l of lines) {
        const f = (l.y - y0) / (y1 - y0 || 1);
        l.edge = outer.has(l.y) && (f > 0.9 || f < 0.1);
      }
      if (lines.map(l => l.text).join('').replace(/\s/g, '').length >= 3) {
        pages.push({ p, lines });
      } else {
        const ops = await page.getOperatorList();
        if (ops.fnArray.some(f => imageOps.has(f))) scanned.push(p);
      }
    }
    const outline = await pdfOutline(doc);
    const furniture = runningLines(pages, n);
    const kept = {};
    for (const { p, lines } of pages) {
      kept[p] = lines.filter(l => !(l.edge && furniture(l)));
      const text = pdfText(kept[p]);
      if (text) units.push({ text, page: p, soft: true });
    }
    // A bookmark points at a height on its page; count the words in the
    // lines above that height to land near the right word, not just the page.
    for (const o of outline) {
      if (o.top == null || !kept[o.page]) continue;
      o.offset = kept[o.page].filter(l => l.y > o.top + 1).reduce((sum, l) => sum + l.text.split(/\s+/).filter(Boolean).length, 0);
    }

    let note = '';
    if (scanned.length) {
      const texts = await recognize(scanned.map(p => async () => {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: Math.min(4, Math.max(2, 2400 / page.getViewport({ scale: 1 }).width)) });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        return canvas;
      }), progress, signal);
      scanned.forEach((p, i) => {
        const text = markHyphens(texts[i]).replace(/\s+/g, ' ').trim();
        if (text) units.push({ text, page: p, soft: true });
      });
      units.sort((a, b) => a.page - b.page);
      note = scanned.length === n
        ? 'This PDF is scanned images, so its text was read with text recognition. Some words may be misread.'
        : `${scanned.length} scanned ${scanned.length === 1 ? 'page was' : 'pages were'} read with text recognition. Some words there may be misread.`;
    }
    return { units: resolveHyphens(joinAcrossPages(units)), pageLabel: 'Page', pagesReal: true, pageCount: n, note, outline };
  }

  // The PDF's bookmarks, three levels deep, as page numbers.
  async function pdfOutline(doc) {
    const out = [];
    try {
      const walk = async (items, level) => {
        for (const it of items || []) {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          if (Array.isArray(dest) && dest[0] != null) {
            const page = typeof dest[0] === 'object' ? (await doc.getPageIndex(dest[0])) + 1
              : Number.isInteger(dest[0]) ? dest[0] + 1 : 0;
            const title = (it.title || '').replace(/\s+/g, ' ').trim();
            // [page, {name: 'XYZ'}, left, top, zoom] or [page, {name: 'FitH'}, top]
            const kind = dest[1] && dest[1].name;
            const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
            if (page && title) out.push({ title, level, page, top: typeof top === 'number' ? top : null });
          }
          if (level < 3) await walk(it.items, level + 1);
        }
      };
      await walk(await doc.getOutline(), 1);
    } catch { /* a broken outline just means no Contents */ }
    return out;
  }

  // pdf.js hands back positioned text runs, not words. A gap wider than a
  // fraction of the font height is a space; a change in baseline is a line.
  function pdfLines(items) {
    const lines = [];
    let cur = null, last = null;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const [, , c, d, x, y] = it.transform;
      const h = Math.hypot(c, d) || it.height || 10;
      if (!cur || (it.str && last && Math.abs(y - last.y) > h * 0.5)) {
        if (!it.str) continue;
        cur = { y, text: '' };
        lines.push(cur);
      } else if (it.str && last && x - last.end > h * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) {
        cur.text += ' ';
      }
      cur.text += it.str;
      if (it.str) last = { y, end: x + it.width };
      if (it.hasEOL) cur = null;
    }
    return lines.filter(l => l.text.trim());
  }

  function pdfText(lines) {
    let out = lines.map(l => l.text).join('\n');
    // A line that starts or ends on a dash continues the same word run.
    out = out.replace(/\s*\n\s*(?=\u2014)|(?<=\u2014)\s*\n\s*/g, '');
    return markHyphens(out).replace(/\s+/g, ' ').trim();
  }

  // Running headers and footers (a title, a date, "Page 3 of 40") would
  // otherwise be read out in the middle of a sentence on every page. An edge
  // line counts as one when the same line, ignoring its numbers, sits at the
  // same height on at least 40% of pages. A bare page number always counts.
  function runningLines(pages, n) {
    const key = l => Math.round(l.y) + '|' + l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const counts = new Map();
    for (const { lines } of pages) {
      for (const k of new Set(lines.filter(l => l.edge).map(key))) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const need = Math.max(2, Math.ceil(n * 0.4));
    const pageNo = /^\s*(page\s*)?\d+(\s*(of|\/)\s*\d+)?\s*$|^\s*[-\u2013\u2014]\s*\d+\s*[-\u2013\u2014]\s*$/i;
    const roman = /^\s*[ivxlc]{1,6}\s*$/;
    return l => pageNo.test(l.text) || roman.test(l.text) || (n >= 2 && (counts.get(key(l)) || 0) >= need);
  }

  // A word hyphenated across a page break ("of-" on one page, "fice" on the
  // next) is carried back to the page it started on.
  function joinAcrossPages(units) {
    for (let i = 0; i + 1 < units.length; i++) {
      const u = units[i], v = units[i + 1];
      if (!/\p{Ll}-$/u.test(u.text) || !/^\p{Ll}/u.test(v.text)) continue;
      const m = v.text.match(/^(\S+)\s*/);
      u.text = u.text.slice(0, -1) + LINE_HYPHEN + m[1];
      v.text = v.text.slice(m[0].length);
    }
    return units.filter(u => u.text);
  }

  // ---------------------------------------------------------------- zip-based formats

  async function zipped(buf, progress) {
    await needZip();
    const zip = await window.JSZip.loadAsync(buf);
    if (zip.file('word/document.xml')) return docx(zip);
    if (zip.file('ppt/presentation.xml')) return pptx(zip);
    if (zip.file('xl/workbook.xml')) return xlsx(zip);
    if (zip.file('META-INF/container.xml')) return epub(zip, progress);
    if (zip.file('content.xml')) return odf(zip);
    throw new Error('This is a zip archive, not a document. Unzip it and open the document inside.');
  }

  // Word only records where pages broke when it last laid the document out
  // (w:lastRenderedPageBreak). Files that never went through Word (Google
  // Docs exports, converters) don't have those, and explicit page breaks
  // alone would undercount pages, so those files have no page numbers.
  async function docx(zip) {
    const doc = parseXml(await zip.file('word/document.xml').async('string'));
    const body = byLocal(doc, 'body')[0];
    const real = byLocal(doc, 'lastRenderedPageBreak').length > 0;
    // Heading levels come from the styles: "heading 1" to "heading 3" and
    // "Title" by name, or any style with an outline level.
    const levels = {};
    const styles = zip.file('word/styles.xml');
    if (styles) {
      for (const st of byLocal(parseXml(await styles.async('string')), 'style')) {
        const nameEl = byLocal(st, 'name')[0];
        const name = nameEl ? attr(nameEl, 'val') || '' : '';
        const ol = byLocal(st, 'outlineLvl')[0];
        const m = name.match(/^heading\s*([1-9])$/i);
        const lvl = m ? +m[1] : /^title$/i.test(name) ? 1 : ol ? +attr(ol, 'val') + 1 : 0;
        if (lvl >= 1 && lvl <= 3) levels[attr(st, 'styleId')] = lvl;
      }
    }
    const headingOf = p => {
      const pPr = Array.from(p.children).find(ch => ch.localName === 'pPr');
      if (!pPr) return 0;
      const ol = Array.from(pPr.children).find(ch => ch.localName === 'outlineLvl');
      if (ol) { const v = +attr(ol, 'val') + 1; return v <= 3 ? v : 0; }
      const ps = Array.from(pPr.children).find(ch => ch.localName === 'pStyle');
      const id = ps ? attr(ps, 'val') : '';
      if (!id) return 0;
      if (levels[id]) return levels[id];
      const m = id.match(/^heading([1-3])$/i);
      return m ? +m[1] : /^title$/i.test(id) ? 1 : 0;
    };
    const c = collector();
    (function walk(node) {
      for (let el = node.firstElementChild; el; el = el.nextElementSibling) {
        switch (el.localName) {
          case 't': c.add(el.textContent); break;
          case 'tab': case 'cr': c.add(' '); break;
          case 'br': c.add(' '); break;
          case 'noBreakHyphen': c.add('-'); break;
          case 'lastRenderedPageBreak': c.brk(); break;
          case 'p': { const h = headingOf(el); walk(el); c.flush(false, h); break; }
          case 'tc': walk(el); c.add(' '); break;
          // formatting, field codes, deleted revisions, and the duplicate
          // copy of every text box that Word writes for old readers
          case 'pPr': case 'rPr': case 'instrText': case 'delText': case 'del': case 'moveFrom':
          case 'Fallback': case 'sectPr': break;
          default: walk(el);
        }
      }
    })(body);
    c.flush();
    return { units: c.units, pageLabel: 'Page', pagesReal: real, pageCount: real ? c.page : 0,
             pageNote: real ? 'Page numbers are where Word placed the page breaks when this file was last saved.' : '' };
  }

  async function pptx(zip) {
    const pres = parseXml(await zip.file('ppt/presentation.xml').async('string'));
    const rels = await readRels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt');
    let paths = byLocal(pres, 'sldId').map(el => rels[el.getAttributeNS(R_NS, 'id')]).filter(Boolean);
    if (!paths.length) {
      paths = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    }
    const c = collector();
    const outline = [];
    for (let i = 0; i < paths.length; i++) {
      c.setPage(i + 1);
      const f = zip.file(paths[i]);
      if (!f) continue;
      const slide = parseXml(await f.async('string'));
      const titleShape = byLocal(slide, 'sp').find(sp => byLocal(sp, 'ph').some(ph => /^(title|ctrTitle)$/.test(ph.getAttribute('type') || '')));
      const title = titleShape ? byLocal(titleShape, 't').map(t => t.textContent).join(' ').replace(/\s+/g, ' ').trim() : '';
      if (title) outline.push({ title, level: 1, page: i + 1 });
      (function walk(node) {
        for (let el = node.firstElementChild; el; el = el.nextElementSibling) {
          if (el.localName === 't') c.add(el.textContent);
          else if (el.localName === 'br') c.add(' ');
          else if (el.localName === 'p') { walk(el); c.flush(); }
          else if (el.localName !== 'Fallback') walk(el);
        }
      })(slide.documentElement);
      c.flush();
    }
    return { units: c.units, pageLabel: 'Slide', pagesReal: true, pageCount: paths.length, outline };
  }

  async function xlsx(zip) {
    const shared = [];
    const ss = zip.file('xl/sharedStrings.xml');
    if (ss) {
      for (const si of byLocal(parseXml(await ss.async('string')), 'si')) {
        shared.push(byLocal(si, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join(''));
      }
    }
    const wb = parseXml(await zip.file('xl/workbook.xml').async('string'));
    const rels = await readRels(zip, 'xl/_rels/workbook.xml.rels', 'xl');
    const sheets = byLocal(wb, 'sheet');
    const c = collector();
    for (let i = 0; i < sheets.length; i++) {
      c.setPage(i + 1);
      const f = zip.file(rels[sheets[i].getAttributeNS(R_NS, 'id')] || '');
      if (!f) continue;
      c.add(sheets[i].getAttribute('name') || `Sheet ${i + 1}`);
      c.flush();
      for (const row of byLocal(parseXml(await f.async('string')), 'row')) {
        for (const cell of byLocal(row, 'c')) {
          const t = cell.getAttribute('t');
          const v = byLocal(cell, 'v')[0];
          let s = '';
          if (t === 's') s = v ? shared[parseInt(v.textContent, 10)] || '' : '';
          else if (t === 'inlineStr') s = byLocal(cell, 't').map(x => x.textContent).join('');
          else if (t === 'b') s = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
          else s = v ? v.textContent : '';
          if (s) c.add(s + ' ');
        }
        c.flush();
      }
    }
    const outline = sheets.map((sh, i) => ({ title: sh.getAttribute('name') || `Sheet ${i + 1}`, level: 1, page: i + 1 }));
    return { units: c.units, pageLabel: 'Sheet', pagesReal: true, pageCount: sheets.length, outline };
  }

  // OpenDocument: text documents carry soft page breaks when LibreOffice
  // saved them; presentations have one draw:page per slide; spreadsheets one
  // table per sheet.
  async function odf(zip) {
    const doc = parseXml(await zip.file('content.xml').async('string'));
    const body = byLocal(doc, 'body')[0];
    const kind = body && body.firstElementChild ? body.firstElementChild.localName : 'text';
    const c = collector();
    let slides = 0;
    let softBreaks = 0;
    (function walk(node) {
      for (let el = node.firstElementChild; el; el = el.nextElementSibling) {
        switch (el.localName) {
          case 'p': walkInline(el); c.flush(); break;
          case 'h': { const lvl = +(attr(el, 'outline-level') || 1); walkInline(el); c.flush(false, lvl <= 3 ? lvl : 0); break; }
          case 'soft-page-break': if (kind === 'text') { c.brk(); softBreaks++; } break;
          case 'page': if (kind === 'presentation' || kind === 'drawing') c.setPage(++slides); walk(el); break;
          case 'table':
            if (kind === 'spreadsheet') { c.setPage(++slides); c.add(el.getAttributeNS('*', 'name') || attr(el, 'name') || ''); c.flush(); }
            walk(el); break;
          case 'table-cell': walk(el); c.add(' '); break;
          case 'table-row': walk(el); c.flush(); break;
          case 'note': case 'annotation': case 'tracked-changes': case 'notes': case 'forms': break;
          default: walk(el);
        }
      }
    })(body);
    function walkInline(node) {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { c.add(n.data); continue; }
        if (n.nodeType !== 1) continue;
        const ln = n.localName;
        if (ln === 's' || ln === 'tab' || ln === 'line-break') c.add(' ');
        else if (ln === 'soft-page-break') { c.brk(); softBreaks++; }
        else if (ln === 'note' || ln === 'annotation') continue;
        else walkInline(n);
      }
    }
    c.flush();
    if (kind === 'presentation') return { units: c.units, pageLabel: 'Slide', pagesReal: true, pageCount: slides };
    if (kind === 'drawing') return { units: c.units, pageLabel: 'Page', pagesReal: true, pageCount: slides };
    if (kind === 'spreadsheet') return { units: c.units, pageLabel: 'Sheet', pagesReal: true, pageCount: slides };
    const real = softBreaks > 0;
    return { units: c.units, pageLabel: 'Page', pagesReal: real, pageCount: real ? c.page : 0 };
  }

  async function epub(zip, progress) {
    const container = parseXml(await zip.file('META-INF/container.xml').async('string'));
    const rootfile = byLocal(container, 'rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    const opfFile = opfPath && zip.file(opfPath);
    if (!opfFile) throw new Error('This EPUB is missing its table of contents file and could not be read.');
    const opf = parseXml(await opfFile.async('string'));
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifest = {};
    const items = byLocal(opf, 'item');
    for (const item of items) manifest[item.getAttribute('id')] = item.getAttribute('href');
    const spine = byLocal(opf, 'itemref').map(r => manifest[r.getAttribute('idref')]).filter(Boolean);
    const fileOf = path => zip.file(path) || zip.file(safeDecode(path));

    const units = [];
    const where = {}; // "path" or "path#id" -> unit index
    for (let i = 0; i < spine.length; i++) {
      progress(`Reading chapter ${i + 1} of ${spine.length}`);
      const path = safeDecode(resolvePath(base, spine[i]));
      const f = fileOf(path);
      if (!f) continue;
      const doc = new DOMParser().parseFromString(await f.async('string'), 'text/html');
      const start = units.length;
      where[path] = start;
      units.push(...htmlUnits(doc.body || doc.documentElement, (id, k) => { where[path + '#' + id] = start + k; }));
    }

    // The book's own contents page: EPUB 3 nav document, or EPUB 2 NCX.
    const outline = [];
    const add = (title, href, dir, level) => {
      if (!title || !href || level > 3) return;
      const [p, frag] = href.split('#');
      const path = safeDecode(resolvePath(dir, p));
      const unit = frag != null && where[path + '#' + safeDecode(frag)] != null ? where[path + '#' + safeDecode(frag)] : where[path];
      if (unit != null && unit < units.length) outline.push({ title: title.replace(/\s+/g, ' ').trim(), level, unit });
    };
    try {
      const navItem = items.find(it => /\bnav\b/.test(it.getAttribute('properties') || ''));
      const ncxId = (byLocal(opf, 'spine')[0] || { getAttribute: () => null }).getAttribute('toc');
      const ncxItem = items.find(it => it.getAttribute('id') === ncxId || it.getAttribute('media-type') === 'application/x-dtbncx+xml');
      if (navItem) {
        const path = safeDecode(resolvePath(base, navItem.getAttribute('href')));
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const nav = new DOMParser().parseFromString(await fileOf(path).async('string'), 'text/html');
        const navs = Array.from(nav.querySelectorAll('nav'));
        const toc = navs.find(n => /toc/.test(n.getAttribute('epub:type') || '')) || navs[0];
        if (toc) {
          for (const a of toc.querySelectorAll('a[href]')) {
            let level = 0;
            for (let el = a; el && el !== toc; el = el.parentElement) if (el.localName === 'ol' || el.localName === 'ul') level++;
            add(a.textContent, a.getAttribute('href'), dir, level || 1);
          }
        }
      } else if (ncxItem) {
        const path = safeDecode(resolvePath(base, ncxItem.getAttribute('href')));
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const ncx = parseXml(await fileOf(path).async('string'));
        for (const np of byLocal(ncx, 'navPoint')) {
          let level = 0;
          for (let el = np; el; el = el.parentElement) if (el.localName === 'navPoint') level++;
          const label = byLocal(np, 'text')[0];
          const content = Array.from(np.children).find(ch => ch.localName === 'content');
          add(label && label.textContent, content && content.getAttribute('src'), dir, level);
        }
      }
    } catch { /* a broken contents page falls back to the headings */ }
    const words = units.reduce((n, u) => n + u.text.split(' ').length, 0);
    if (spine.length && words < spine.length * 3) {
      throw new Error('This EPUB came out nearly empty. It is probably copy-protected (DRM), which the reader cannot open.');
    }
    return { units, pageLabel: 'Page', pagesReal: false, pageCount: 0, outline };
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

  // ---------------------------------------------------------------- HTML, RTF, plain text

  const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre',
    'figure', 'figcaption', 'table', 'tr', 'caption', 'hr', 'br', 'address', 'details', 'summary', 'body']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'title',
    'iframe', 'object', 'canvas', 'select', 'button']);

  // onId(id, unitIndex) reports where each element id lands, so an EPUB's
  // contents page can point into the middle of a chapter file.
  function htmlUnits(root, onId) {
    const c = collector();
    (function walk(node) {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { c.add(n.data); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.localName;
        if (SKIP.has(tag) || n.hasAttribute('hidden')) continue;
        if (onId && n.id) onId(n.id, c.units.length);
        const h = /^h[1-3]$/.test(tag) ? +tag[1] : 0;
        if (tag === 'td' || tag === 'th') { walk(n); c.add(' '); }
        else if (h) { c.flush(); walk(n); c.flush(false, h); }
        else if (BLOCK.has(tag)) { c.flush(); walk(n); c.flush(); }
        else walk(n);
      }
    })(root);
    c.flush();
    return c.units;
  }

  function htmlDoc(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return { units: htmlUnits(doc.body || doc.documentElement), pageLabel: 'Page', pagesReal: false, pageCount: 0 };
  }

  // Text in a vector drawing: each <text> element is a line.
  function svgDoc(text) {
    const units = byLocal(parseXml(text), 'text').map(t => t.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean).map(t => ({ text: t, page: 1, soft: false }));
    return { units, pageLabel: 'Page', pagesReal: false, pageCount: 0 };
  }

  // A small RTF reader: enough for what TextEdit, Word and WordPad write.
  // Skips font/colour/style tables, pictures and every \* destination;
  // \par ends a paragraph.
  const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header',
    'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote',
    'listtable', 'listoverridetable', 'rsidtbl', 'xmlnstbl', 'themedata', 'colorschememapping',
    'datastore', 'latentstyles', 'generator', 'filetbl', 'revtbl', 'expandedcolortbl']);
  const RTF_CHARS = { emdash: '\u2014', endash: '\u2013', lquote: '\u2018', rquote: '\u2019',
    ldblquote: '\u201C', rdblquote: '\u201D', bullet: '\u2022', tab: ' ', line: ' ' };

  function rtf(buf) {
    const src = new TextDecoder('latin1').decode(new Uint8Array(buf));
    const cp1252 = new TextDecoder('windows-1252');
    const c = collector();
    const stack = [];
    let skip = false, uc = 1, pendingSkip = 0;
    const re = /\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[5] === '{') { stack.push({ skip, uc }); continue; }
      if (m[5] === '}') { ({ skip, uc } = stack.pop() || { skip: false, uc: 1 }); continue; }
      if (m[1]) {
        const w = m[1];
        if (RTF_SKIP.has(w)) { skip = true; continue; }
        if (w === 'uc') { uc = parseInt(m[2] || '1', 10); continue; }
        if (skip) continue;
        if (w === 'u') {
          let n = parseInt(m[2] || '0', 10);
          if (n < 0) n += 65536;
          c.add(String.fromCharCode(n));
          pendingSkip = uc;
        } else if (w === 'par' || w === 'sect' || w === 'page') c.flush();
        else if (RTF_CHARS[w]) c.add(RTF_CHARS[w]);
        continue;
      }
      if (m[3]) {
        if (skip) continue;
        if (pendingSkip > 0) { pendingSkip--; continue; }
        c.add(cp1252.decode(new Uint8Array([parseInt(m[3], 16)])));
        continue;
      }
      if (m[4]) {
        const s = m[4];
        if (s === '*') { skip = true; continue; }
        if (skip) continue;
        if (s === '\n' || s === '\r') c.flush();
        else if (s === '~') c.add(' ');
        else if (s === '_') c.add('-');
        else if (s === '\\' || s === '{' || s === '}') c.add(s);
        continue;
      }
      if (m[6] && !skip) {
        let t = m[6];
        if (pendingSkip > 0) { const k = Math.min(pendingSkip, t.length); t = t.slice(k); pendingSkip -= k; }
        c.add(t);
      }
    }
    c.flush();
    // \page marks only explicit breaks, not where text flowed onto a new
    // page, so RTF has no page numbers (same reasoning as Word's).
    return { units: c.units, pageLabel: 'Page', pagesReal: false, pageCount: 0 };
  }

  function stripMarkdown(s) {
    return s
      .replace(/^\s*(```|~~~).*$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*[-:| ]{3,}$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/(\*\*|\*|~~|`)/g, '')
      .replace(/(?<!\w)_+|_+(?!\w)/g, '');
  }

  function markdown(text) {
    // Headings become their own paragraphs even without blank lines round them.
    const units = [];
    const src = text.replace(/\r\n?/g, '\n').replace(/^(#{1,6}[ \t].*)$/gm, '\n$1\n');
    for (const para of src.split(/\n\s*\n/)) {
      const m = para.trim().match(/^(#{1,6})[ \t]+(.*)$/);
      const t = stripMarkdown(m ? m[2].replace(/[ \t]#+\s*$/, '') : para).replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const lvl = m ? m[1].length : 0;
      units.push(lvl && lvl <= 3 ? { text: t, page: 1, soft: false, heading: lvl } : { text: t, page: 1, soft: false });
    }
    return { units, pageLabel: 'Page', pagesReal: false, pageCount: 0 };
  }

  function plain(text, ext) {
    if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return markdown(text);
    if (ext === 'srt' || ext === 'vtt') {
      text = text.split(/\r?\n/).filter(l => !/-->/.test(l) && !/^\s*\d+\s*$/.test(l) && l.trim() !== 'WEBVTT').join('\n');
    }
    const chunks = text.split('\f');
    const units = [];
    chunks.forEach((chunk, i) => {
      for (const para of chunk.split(/\r?\n\s*\r?\n/)) {
        const t = para.replace(/\s+/g, ' ').trim();
        if (t) units.push({ text: t, page: i + 1, soft: false });
      }
    });
    const real = chunks.length > 1;
    return { units, pageLabel: 'Page', pagesReal: real, pageCount: real ? chunks.length : 0 };
  }

  // Text recognition misreads small text badly (a screenshot at normal size
  // came back as "rains th eye"), so small images are enlarged first.
  async function upscaled(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(4, Math.max(1, 2400 / bmp.width));
    if (scale === 1) return bmp;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function image(file, progress, signal) {
    let text;
    try {
      [text] = await recognize([() => upscaled(file)], progress, signal);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (/internet|recognition/.test(err.message)) throw err;
      throw new Error('This image could not be read. Save it as PNG or JPG and try again.');
    }
    const units = markHyphens(text).split(/\n\s*\n/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
      .map(t => ({ text: t, page: 1, soft: false }));
    resolveHyphens(units);
    return { units, pageLabel: 'Page', pagesReal: false, pageCount: 0,
             note: 'This image was read with text recognition. Some words may be misread.' };
  }

  window.SRExtract = { fromFile, fromText };
})();
