import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from '../config'

let client: SupabaseClient | null = null

function sb(): SupabaseClient {
  if (client) return client
  const { url, anonKey } = config.supabase
  if (!url || !anonKey) throw new Error('Supabase is not configured. Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.')
  // Storage only: the dashboard never signs in to Supabase, so skip session handling
  client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }

/** Uploads a resident's photo to Supabase Storage and returns its object path (stored in Firebase as report.photoPath). */
export async function uploadReportPhoto(file: Blob, reportId: string): Promise<string> {
  const d = new Date()
  const ext = EXT[file.type] ?? 'jpg'
  const path = `reports/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${reportId}.${ext}`
  const { error } = await sb().storage.from(config.supabase.bucket).upload(path, file, {
    contentType: file.type || 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  })
  if (error) throw new Error(`Photo upload to Supabase failed: ${error.message}`)
  return path
}

export async function removeReportPhoto(path: string) {
  await sb().storage.from(config.supabase.bucket).remove([path]).catch(() => {})
}

// private bucket: signed URLs, cached until 5 minutes before they expire
const SIGNED_FOR_S = 3600
const signed = new Map<string, { url: string; exp: number }>()

/** Turns Supabase object paths into URLs the <img> tags can load. Full http(s) URLs pass through unchanged. */
export async function photoUrls(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const todo: string[] = []
  for (const p of new Set(paths)) {
    if (/^https?:\/\//.test(p)) out[p] = p
    else if (config.supabase.publicBucket) out[p] = sb().storage.from(config.supabase.bucket).getPublicUrl(p).data.publicUrl
    else {
      const hit = signed.get(p)
      if (hit && hit.exp > Date.now()) out[p] = hit.url
      else todo.push(p)
    }
  }
  if (todo.length) {
    const { data, error } = await sb().storage.from(config.supabase.bucket).createSignedUrls(todo, SIGNED_FOR_S)
    if (!error)
      for (const row of data ?? [])
        if (row.path && row.signedUrl) {
          out[row.path] = row.signedUrl
          signed.set(row.path, { url: row.signedUrl, exp: Date.now() + (SIGNED_FOR_S - 300) * 1000 })
        }
  }
  return out
}
