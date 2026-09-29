-- Speed Reader: everything sync needs, in one file. Paste it into the SQL
-- editor of a Supabase project and run it once; running it again is safe.
--
-- Three tables and one storage bucket, all private to their owner:
--   documents  one row per document you've opened: title, file type, size,
--              where you are, and the chapters AI found in it (structure)
--   bookmarks  word positions you've marked in a document
--   settings   your reader settings as one JSON object
--   storage bucket "documents"  the extracted text of each document, gzipped,
--              at <user id>/<document key>.json.gz
--
-- A document key is the first 128 bits of the SHA-256 of the file's bytes
-- (or of pasted text), so the same file matches on every device.
--
-- Sign-in methods (Google, email) are switched on in the dashboard, not here;
-- see README.md.
--
-- Access: the browser only ever holds the anon key. Every policy below
-- limits a signed-in user to rows whose user_id is their own auth.uid(), and
-- signed-out requests (the anon role) get nothing at all.

-- ---------------------------------------------------------------- documents

create table if not exists public.documents (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  doc_key     text        not null check (doc_key ~ '^[0-9a-f]{32}$' or length(doc_key) between 1 and 300),
  title       text        not null check (length(title) <= 500),
  format      text        not null default '' check (length(format) <= 20),
  word_count  integer     not null check (word_count > 0),
  page_label  text        not null default 'Page' check (page_label in ('Page', 'Slide', 'Sheet')),
  page_count  integer     not null default 0 check (page_count >= 0),
  position    integer     not null default 0 check (position >= 0),
  position_at timestamptz not null default now(),
  has_content boolean     not null default false,
  opened_at   timestamptz not null default now(),
  structure   jsonb       check (structure is null or jsonb_typeof(structure) = 'object'),
  primary key (user_id, doc_key),
  check (position < word_count)
);

-- Columns added after the first version, for projects that ran it already.
alter table public.documents add column if not exists format text not null default '' check (length(format) <= 20);
alter table public.documents add column if not exists structure jsonb check (structure is null or jsonb_typeof(structure) = 'object');

create index if not exists documents_recent on public.documents (user_id, opened_at desc);

-- ---------------------------------------------------------------- bookmarks

create table if not exists public.bookmarks (
  user_id    uuid        not null default auth.uid(),
  doc_key    text        not null,
  word_index integer     not null check (word_index >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, doc_key, word_index),
  foreign key (user_id, doc_key) references public.documents (user_id, doc_key) on delete cascade
);

-- ---------------------------------------------------------------- settings

create table if not exists public.settings (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  settings   jsonb       not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- row level security

alter table public.documents enable row level security;
alter table public.bookmarks enable row level security;
alter table public.settings  enable row level security;

-- Only signed-in users, and only their own rows. (select auth.uid()) is
-- evaluated once per query rather than once per row.
drop policy if exists "own documents" on public.documents;
create policy "own documents" on public.documents for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own bookmarks" on public.bookmarks;
create policy "own bookmarks" on public.bookmarks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Newer Supabase projects no longer expose new tables to the API
-- automatically, so grant exactly what the app uses. anon gets nothing.
revoke all on public.documents, public.bookmarks, public.settings from anon;
grant select, insert, update, delete on public.documents, public.bookmarks, public.settings to authenticated;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 52428800)  -- 50 MB per document
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Files live at "<user id>/<document key>.json.gz"; the first folder of the
-- path has to be the signed-in user's id for every operation. Uploading with
-- upsert needs select and update as well as insert.
drop policy if exists "read own document text" on storage.objects;
create policy "read own document text" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "add own document text" on storage.objects;
create policy "add own document text" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "replace own document text" on storage.objects;
create policy "replace own document text" on storage.objects for update to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "delete own document text" on storage.objects;
create policy "delete own document text" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
