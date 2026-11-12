-- Run once in Supabase → SQL Editor. Creates the bucket for resident report photos.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- The web form uploads with the anon key: allow new files under reports/ only (no overwrite, no delete).
drop policy if exists "bahagi web uploads" on storage.objects;
create policy "bahagi web uploads" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'report-photos' and (storage.foldername(name))[1] = 'reports');

-- Public bucket = photos load by plain URL. To keep photos private instead:
--   update storage.buckets set public = false where id = 'report-photos';
--   set VITE_SUPABASE_PUBLIC_BUCKET=false, and allow signed URLs:
-- create policy "bahagi read photos" on storage.objects for select to anon, authenticated using (bucket_id = 'report-photos');
-- The Messenger webhook (report-store.ts) uses the service-role key, which bypasses these policies.
