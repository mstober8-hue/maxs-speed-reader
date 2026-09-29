// Optional sync through Supabase: sign in with Google or an emailed link or code, and
// your library (the extracted text of each document), where you are in each,
// your bookmarks and your settings follow you to other devices.
//
// Everything here is a no-op until config.js has a project URL and anon key,
// and while signed out. The reader always saves to the browser first and
// calls in here afterwards, so a network problem never loses your place; it
// just shows as a sync problem on the account button.
//
// Tables and access rules are in supabase/schema.sql. Every table is locked
// to its owner by row level security, and the document text lives in a
// private storage bucket under a folder named after the user's id.
(function () {
  'use strict';

  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
  const cfg = window.SR_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);

  let sb = null;
  let user = null;
  let onStatus = () => {};
  let pending = 0;
  let lastError = '';

  function status() {
    onStatus(!configured ? 'off' : !user ? 'signed-out' : pending ? 'syncing' : lastError ? 'error' : 'synced', lastError);
  }

  // Runs one sync call while signed in. Failures are recorded for the
  // account button and turned into null, never thrown at the reader.
  async function run(label, fn) {
    if (!sb || !user) return null;
    pending++;
    status();
    try {
      const out = await fn(user.id);
      lastError = '';
      return out;
    } catch (err) {
      lastError = `${label} (${(err && err.message) || err})`;
      console.error('Sync:', label, err);
      return null;
    } finally {
      pending--;
      status();
    }
  }
  const ok = ({ data, error }) => { if (error) throw error; return data; };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load the Supabase library'));
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- auth

  async function init(onUser, statusCallback, onMessage = () => {}) {
    onStatus = statusCallback || onStatus;
    if (!configured) { status(); return; }
    // Coming back from Google (or an emailed link), the address carries either
    // the session or an error. supabase-js reads the session; the error and
    // the leftover tokens are dealt with here.
    const params = new URLSearchParams(location.hash.slice(1) + '&' + location.search.slice(1));
    const returning = params.has('access_token') || params.has('code') || params.has('error');
    const authError = params.get('error_description');
    try {
      if (!window.supabase) await loadScript(SUPABASE_JS);
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        // Implicit flow, so an emailed link also works when opened on a
        // different device from the one that asked for it.
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      });
    } catch (err) {
      lastError = err.message;
      onStatus('error', 'Could not reach Supabase. Reading still works; syncing will resume next time.');
      return;
    }
    let notified;
    let tidied = false;
    const changed = session => {
      user = session ? session.user : null;
      const id = user ? user.id : null;
      status();
      if (returning && !tidied) {
        tidied = true;
        history.replaceState(null, '', location.pathname);
        if (authError) onMessage(`Sign-in didn't work: ${authError.replace(/\+/g, ' ')}`);
        else if (user) onMessage('Signed in. Your library, places and bookmarks now sync.');
      }
      if (id !== notified) { notified = id; onUser(user); }
    };
    // Fires once with the saved session (or none), then on every sign in
    // or out, including one that arrives from an emailed link.
    sb.auth.onAuthStateChange((_event, session) => changed(session));
  }

  // Sends an email with a sign-in link, and a 6-digit code if the project's
  // email template includes {{ .Token }}. The link only works when this page
  // is served over http(s); the code works everywhere, including a page
  // opened straight from disk.
  async function sendLink(email) {
    if (!sb) throw new Error('Sync is not available right now.');
    const redirect = /^https?:$/.test(location.protocol) ? location.origin + location.pathname : undefined;
    ok(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } }));
  }

  // Google sign-in leaves this page for Google and comes back to the same
  // address, so it needs one: a page opened straight from disk (file://) has
  // nowhere for Google to send you back to.
  async function signInWithGoogle() {
    if (!sb) throw new Error('Sync is not available right now.');
    if (!/^https?:$/.test(location.protocol)) {
      throw new Error('Google sign-in needs the reader opened from a web address, not straight from the file. Double-click start.command in the reader\'s folder (or run "python3 -m http.server 8510" there) and open http://localhost:8510. The emailed code works either way.');
    }
    ok(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }));
  }

  // Which sign-in methods the project has switched on, from Supabase's public
  // settings endpoint. Unknown (offline) counts as available.
  async function providers() {
    if (!configured) return {};
    try {
      const res = await fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/auth/v1/settings', { headers: { apikey: cfg.supabaseAnonKey } });
      const ext = (await res.json()).external || {};
      return { google: ext.google !== false, email: ext.email !== false };
    } catch { return {}; }
  }

  async function verifyCode(email, token) {
    if (!sb) throw new Error('Sync is not available right now.');
    ok(await sb.auth.verifyOtp({ email, token, type: 'email' }));
  }

  async function signOut() {
    if (!sb) return;
    await flush();
    await sb.auth.signOut();
  }

  // ---------------------------------------------------------------- settings

  const pullSettings = () => run('loading settings', async () =>
    ok(await sb.from('settings').select('settings, updated_at').maybeSingle()));

  const pushSettings = settings => run('saving settings', async uid =>
    ok(await sb.from('settings').upsert({ user_id: uid, settings, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })));

  // ---------------------------------------------------------------- documents

  const DOC_COLUMNS = 'doc_key, title, format, word_count, page_label, page_count, position, position_at, has_content, opened_at, structure';
  const path = (uid, key) => `${uid}/${key}.json.gz`;

  const listDocs = () => run('loading your library', async () =>
    ok(await sb.from('documents').select(DOC_COLUMNS).order('opened_at', { ascending: false })));

  const getDoc = key => run('loading a document', async () =>
    ok(await sb.from('documents').select(DOC_COLUMNS).eq('doc_key', key).maybeSingle()));

  // Records that the document was opened, and uploads its text the first time
  // so other devices can open it without the original file. The position is
  // left alone here; pushPosition owns it.
  const saveDoc = (meta, data, remote) => run('saving a document', async uid => {
    const row = {
      user_id: uid, doc_key: meta.key, title: meta.title, format: meta.format, word_count: meta.words,
      page_label: meta.pageLabel, page_count: meta.pageCount, opened_at: new Date().toISOString(),
    };
    ok(await sb.from('documents').upsert(row, { onConflict: 'user_id,doc_key' }));
    if (remote && remote.has_content) return;
    const body = await pack({ ...data, title: meta.title });
    ok(await sb.storage.from('documents').upload(path(uid, meta.key), body, { upsert: true, contentType: 'application/gzip' }));
    ok(await sb.from('documents').update({ has_content: true }).eq('doc_key', meta.key));
  });

  // Where the main text starts and where the chapters are, as found by AI.
  const saveStructure = (key, structure) => run('saving chapters', async () =>
    ok(await sb.from('documents').update({ structure }).eq('doc_key', key)));

  const downloadDoc = key => run('downloading a document', async uid =>
    unpack(ok(await sb.storage.from('documents').download(path(uid, key)))));

  // Bookmarks go with the row (on delete cascade).
  const deleteDoc = key => run('removing a document', async uid => {
    ok(await sb.from('documents').delete().eq('doc_key', key));
    const { error } = await sb.storage.from('documents').remove([path(uid, key)]);
    if (error) throw error;
  });

  // Text compresses about 4:1, which matters for a phone downloading a book.
  async function pack(obj) {
    const json = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    if (typeof CompressionStream === 'undefined') return json;
    return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }
  async function unpack(blob) {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    const gz = head[0] === 0x1f && head[1] === 0x8b;
    const text = gz ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await blob.text();
    return JSON.parse(text);
  }

  // ---------------------------------------------------------------- position

  // Positions change several times a second while reading, so they are sent
  // at most every few seconds, plus straight away on pause and when leaving.
  const positions = new Map();
  let posTimer = 0;
  function pushPosition(key, i) {
    if (!sb || !user) return;
    positions.set(key, i);
    if (!posTimer) posTimer = setTimeout(flush, 4000);
  }
  async function flush() {
    clearTimeout(posTimer);
    posTimer = 0;
    if (!positions.size) return;
    const batch = [...positions];
    positions.clear();
    await Promise.all(batch.map(([key, i]) => run('saving your place', async () =>
      ok(await sb.from('documents').update({ position: i, position_at: new Date().toISOString() }).eq('doc_key', key)))));
  }

  // ---------------------------------------------------------------- bookmarks

  const listBookmarks = key => run('loading bookmarks', async () =>
    ok(await sb.from('bookmarks').select('word_index').eq('doc_key', key)).map(r => r.word_index));

  const addBookmark = (key, i) => run('saving a bookmark', async uid =>
    ok(await sb.from('bookmarks').upsert({ user_id: uid, doc_key: key, word_index: i }, { onConflict: 'user_id,doc_key,word_index', ignoreDuplicates: true })));

  const removeBookmark = (key, i) => run('removing a bookmark', async () =>
    ok(await sb.from('bookmarks').delete().eq('doc_key', key).eq('word_index', i)));

  window.SRSync = {
    configured,
    get user() { return user; },
    init, providers, signInWithGoogle, sendLink, verifyCode, signOut,
    pullSettings, pushSettings,
    listDocs, getDoc, saveDoc, saveStructure, downloadDoc, deleteDoc,
    pushPosition, flush,
    listBookmarks, addBookmark, removeBookmark,
  };
})();
