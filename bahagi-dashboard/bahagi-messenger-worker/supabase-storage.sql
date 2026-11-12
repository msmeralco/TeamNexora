-- Supabase is used ONLY for photo storage now. All data lives in Firebase Realtime Database.
-- Run once in Supabase → SQL Editor (or create a public bucket named flood-photos in Storage).

-- Public bucket so the dashboard can show <img src>. Residents' photos become viewable by anyone with the URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flood-photos', 'flood-photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = excluded.public;

-- No insert/update policies are needed: the Worker uploads with the secret (service role) key, which bypasses RLS.
