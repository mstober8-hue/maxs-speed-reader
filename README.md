# Max's Speed Reader

Shows a document one word at a time, with the middle letter of each word in
red and fixed at the centre of the screen, so your eyes stay still.

## Opening it

Online: **https://mstober8-hue.github.io/maxs-speed-reader/**, hosted free on
GitHub Pages from the public repository
[mstober8-hue/maxs-speed-reader](https://github.com/mstober8-hue/maxs-speed-reader).
Pushing to `main` updates the site within a couple of minutes. The only key in
the repository is Supabase's publishable key, which is meant to be public; a
Gemini key lives only in the browser it was typed into.

On this Mac: double-click `index.html`. It works straight from disk, with no
server and no install.

To sign in with Google (see sync below), it has to be opened from a web
address instead: double-click `start.command`, which serves this folder at
http://localhost:8510 and opens it. (The first time, macOS may ask you to allow
it: right-click it, choose Open.) `.claude/launch.json` has the same thing as a
`speedreader` entry.

## What it reads

The reader detects the format from the file's contents, not its name.

| Format | Page numbers | Contents list from |
|---|---|---|
| PDF | Yes. Repeated headers, footers and page numbers are left out of the reading. | The PDF's bookmarks |
| PowerPoint `.pptx`, OpenDocument slides `.odp` | Yes, one per slide | Slide titles |
| Excel `.xlsx`, OpenDocument sheets `.ods` | Yes, one per sheet | Sheet names |
| Word `.docx` | Only if Word itself saved the file (Word records where each page broke). Google Docs exports and converted files have none. | Headings (Title, Heading 1 to 3) |
| OpenDocument text `.odt` | Only if LibreOffice saved it | Headings |
| EPUB (without DRM) | No | The book's own table of contents |
| HTML, Markdown | No | Headings (h1 to h3, `#` to `###`) |
| Plain text | Only with form-feed page breaks | Headings like "Chapter 7" or "PART TWO" |
| RTF, `.srt` / `.vtt` subtitles, SVG, pasted text | No | Headings like "Chapter 7" |
| Scanned PDF | Yes. Scanned pages are read with text recognition (Tesseract). | The PDF's bookmarks |
| Photo or screenshot (PNG, JPG, GIF, BMP, WebP) | No. Read with text recognition. | None |

Page numbers are never estimated. When a file doesn't record its pages, the
reader says "No page numbers in this file" and hides Go to page. Search, the
contents list and the progress bar still work, and they show how far through
the file you are instead.

Text recognition needs internet the first time and can misread words. The page
shows a notice whenever it was used. Small images are enlarged first, because
small text otherwise comes out badly garbled (a test screenshot went from
garbled to 95% of words exact). A scanned page takes several seconds, and
Cancel (or Esc) stops it.

It can't read old binary Office files (`.doc`, `.ppt`, `.xls`), DRM-protected
EPUBs, or HEIC photos. It says so and suggests re-saving the file.

## Finding chapters and the real text with AI

For a file without a contents list of its own (most plain text, many PDFs,
scans), the reader can ask Google's Gemini where the main text starts (after
the title page, copyright, dedication and table of contents) and where every
chapter begins. It then:

- starts a document at the main text instead of the title page, and says so
  (Home still goes to the very beginning; switch this off in Settings)
- shows **Skip to the main text** (or press **S**) while you're in the front matter
- fills **Contents**, the chapter name above the word, and the **« »**
  chapter buttons and **[ ]** keys

Setting it up: get a free API key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) (a Google
account is all it needs) and paste it into Settings, "Finding chapters with AI".
The key stays in this browser and goes only to Google. Once it's in, files that
don't list their own chapters are read automatically when they open (Settings
can switch that off), and **Find chapters (AI)** runs it by hand for any file.
When it runs, the document's text is sent to Google.

How it avoids making things up: the text is sent with a position marker every
50 words, and Gemini answers with the nearest marker plus the first few words
at each chapter. Those words are then looked up in the real text next to that
marker. Anything that can't be found there is dropped, so a chapter that
doesn't exist never shows up, and a chapter title listed in the table of
contents isn't mistaken for the chapter itself. Results are saved, so a
document is only sent once; with sync on, other devices get the chapters
without calling Gemini (or needing a key).

Which model: the reader asks Google which models the key can use and takes the
newest stable Flash model (gemini-3.8-flash as of September 2026), falling back
to older ones if a model has no free quota. Long books go in parts of 60,000
words. If Gemini's free per-minute limit is hit, it waits the time Google asks
for and carries on.

Without a key, plain-text files still get chapters from headings like
"Chapter 7", "PART TWO" or "Prologue" (a run of them close together is taken
to be a table of contents and skipped).

## Controls

- **Drag and drop** a file anywhere on the page to open it (or text from another app)
- **Space** or click the word: play and pause (it also pauses itself when you switch tabs)
- The **10** buttons either side of play: back or forward 10 seconds of reading at your
  current speed (pauses at punctuation included, so about 50 words at 300 wpm)
- **Left / Right arrow**: back or forward one sentence (hold **Shift** for one word)
- **Up / Down arrow**: speed ±25 wpm (the slider covers 100 to 1000, and the box accepts 50 to 2000)
- **[ and ]**, or the **« »** buttons: previous and next chapter. **Page Up / Page Down**: previous and next page
- **S**: skip the title page and other front matter (once AI has found where the text starts)
- **B**: bookmark the current word (or the bookmark button). **Bookmarks** lists them
- **F**: focus mode, which hides everything but the word, the bar and the buttons. Esc leaves it
- **/**: search. Matches are listed as you type and show as ticks on the progress
  bar; Enter goes to the next one after where you are
- **Contents**: the file's sections, with the current one highlighted. The current
  section's name also sits above the word
- **Go to page**: jumps to the first word of that page (only for files with page numbers)
- **Home**: back to the start
- Drag or click the progress bar to move. Hovering shows the section and the page
  (or the percentage).

While paused, the text around the current word appears below. Click any word
there to start from it.

**Settings** (below the text): words at a time (1, 2 or 3; groups never run past
a comma or the end of a sentence), font (Atkinson Hyperlegible, Lexend, a serif,
or monospace), the focus letter's colour, theme, text size, and switches for
longer pauses at punctuation, a slower start each time you press play, going
back to the start of the sentence when you resume, the guide lines, and the
surrounding text. "Pause longer at punctuation" makes the actual rate a little
slower than the wpm setting, and "time left" accounts for it.

**Your library**: the start screen lists the last 25 documents you opened, with
how far you got, and opens them again without the original file. Their text is
kept in this browser (IndexedDB). The × removes one. A document is recognised
by its contents, so a renamed copy picks up where the original left off.

## Syncing with Supabase (optional)

Sign in with Google (or an emailed link or code) and your library, where you are
in each document, your bookmarks, the chapters AI found, and your settings follow
you to other devices. Documents you open on
one device appear on the others as "from another device" and open without the
file. Without it, the reader works exactly the same and keeps everything in
the browser.

**This copy is already set up** (as of 29 September 2026): the Supabase project
"speed reader" (`eprnqwvakpqhazdvrwlh`, US East, free plan) has the schema
applied, `config.js` points at it, the Site URL is `http://localhost:8510`, and
Google sign-in is switched on through a Google Cloud OAuth client. To sign in
with Google, open the reader with `start.command` and keep its window open.
The Google app is in testing mode, so only accounts listed as test users under
Google Auth Platform, Audience can sign in; add people there (or publish the
app) before anyone else uses it.

Setting up a new copy takes about ten minutes:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the project's SQL editor, paste all of `supabase/schema.sql` and run it.
   It creates the three tables, a private storage bucket, and the access rules.
   Running it again is harmless.
3. Under Project Settings, API, copy the project URL and the anon (publishable)
   key into `config.js`. Never use the `service_role` key there.
4. Under Authentication, URL Configuration, set the Site URL to
   `http://localhost:8510` and add `http://localhost:8510/**` to the redirect
   URLs (plus the address of anywhere else you host it), so Google and the
   sign-in email can send you back to the reader.
5. **Google sign-in.** In [Google Cloud Console](https://console.cloud.google.com/auth/clients/create),
   create an OAuth client of type **Web application**:
   - Authorized JavaScript origins: `http://localhost:8510`
   - Authorized redirect URI: the callback URL shown on Supabase's Google
     provider page, which looks like `https://<your-project>.supabase.co/auth/v1/callback`
   - Under Data Access (Scopes), make sure `openid`, `.../auth/userinfo.email`
     and `.../auth/userinfo.profile` are included.

   Then in Supabase, Authentication, Sign In / Providers, Google: switch it on
   and paste the client ID and client secret. The reader checks which methods
   the project has switched on and only shows those.
6. Optional, for signing in from a page opened straight from disk: Google
   can't return to a file, so use the email there. Under Authentication, Emails,
   Magic Link, add `{{ .Token }}` to the template; the email then carries a
   6-digit code as well as the link, and the code works anywhere.

How it behaves:

- Everything is saved in the browser first and synced afterwards, so a dropped
  connection never loses your place. The dot on the account button is green when
  synced, amber while syncing, and red with the reason if something failed.
- Your place is sent at most every 4 seconds while reading, and straight away
  when you pause, switch tabs or close the page.
- When you open a document, if another device was further along more recently,
  the reader jumps there and says so. Bookmarks from all devices are merged.
- The text of each document is stored gzipped (about a quarter of its size) in
  a private bucket, under a folder named after your user id.
- Settings from your account replace this browser's when you sign in. The
  Gemini key is not synced; it stays in the browser you typed it into.
- Removing a document from the library while signed in removes it from every
  device, along with your place and bookmarks in it (it asks first).

Access rules: every table is locked to its owner by row level security, and the
storage bucket only lets you read and write inside your own folder. Signed-out
requests get nothing. These rules were run against a real Postgres (PGlite)
with stand-ins for Supabase's auth and storage schemas: 36 checks covering one
user reading, changing, deleting or impersonating another's rows, files and
chapters all passed, loosening the policies made 9 of them fail as they should,
and re-running the file on a database made by the earlier version adds the new
columns. The sync client was tested end to end against an in-browser stand-in
for Supabase (Google sign-in and the return from Google, email sign-in, upload,
a second device picking up the place, bookmarks and AI chapters, a network
failure and recovery, sign out).

On the live project (29 September 2026): the same isolation checks, run inside
a transaction that was rolled back, all held (one user could not see, change,
delete or impersonate another's documents, bookmarks, settings or files, and
signed-out requests were refused), and Supabase's security advisor reported
nothing. A real Google sign-in came back signed in, and a test document's row,
place, bookmark, compressed text and settings all arrived in the database and
downloaded back intact; the test document was then deleted. The AI chapters
have only been run against a stand-in for the Gemini API so far.

## Files

- `index.html`: the page and its styles
- `extract.js`: turns each file format into paragraphs tagged with page numbers
  and headings, plus the file's own contents list
- `reader.js`: playback, progress bar, search, contents, bookmarks, library,
  settings
- `ai.js`: finding chapters and the start of the text with Gemini
- `sync.js`: the optional Supabase sync; does nothing until `config.js` is filled in
- `start.command`: serves the folder at http://localhost:8510 (needed for Google sign-in)
- `config.js`: the Supabase project URL and anon key (empty by default)
- `supabase/schema.sql`: tables, storage bucket and access rules for sync
- `vendor/`: pdf.js 3.11.174 and JSZip 3.10.1, stored locally so PDFs and Office
  files open offline. They load only when a file needs them. Text recognition,
  the Supabase library and the optional fonts load from the internet when used.
