/**
 * Save a resident report the way the dashboard reads it: photo → Supabase Storage, report → Firebase /reports.
 * Use from the Messenger webhook (backend/messenger-webhook.ts) after Bedrock has scored the photo:
 *
 *   import { saveReport } from './firebase-bridge/report-store'
 *   const id = await saveReport({ photo: buf, contentType: 'image/jpeg', source: 'messenger', note, barangayId, streetId,
 *                                 estimatedCm, confidence, liveWireRisk, duplicate, counted })
 *
 * Needs (server side only, never in the browser):
 *   FIREBASE_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS (service-account JSON)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET (default report-photos)
 */
import { createClient } from '@supabase/supabase-js'
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getDatabase, ServerValue } from 'firebase-admin/database'

export interface ReportInput {
  photo?: Buffer | Uint8Array
  contentType?: string
  source: 'messenger' | 'viber' | 'sms' | 'web'
  note: string
  barangayId: string
  streetId?: string
  estimatedCm: number
  confidence: number
  duplicate?: boolean
  counted?: boolean
  liveWireRisk?: boolean
}

const BUCKET = process.env.SUPABASE_BUCKET ?? 'report-photos'

function fb() {
  if (!getApps().length) initializeApp({ credential: applicationDefault(), databaseURL: process.env.FIREBASE_DATABASE_URL })
  return getDatabase()
}
let supa: ReturnType<typeof createClient> | null = null
function sb() {
  if (!supa) supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return supa
}

export async function saveReport(r: ReportInput): Promise<string> {
  const node = fb().ref('reports').push()
  const id = node.key!
  let photoPath: string | undefined
  if (r.photo) {
    const d = new Date()
    const ext = r.contentType === 'image/png' ? 'png' : r.contentType === 'image/webp' ? 'webp' : 'jpg'
    photoPath = `reports/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${id}.${ext}`
    const { error } = await sb().storage.from(BUCKET).upload(photoPath, r.photo, { contentType: r.contentType ?? 'image/jpeg', upsert: false })
    if (error) throw new Error(`Supabase upload failed: ${error.message}`)
  }
  const { photo: _photo, contentType: _ct, ...rest } = r
  // Firebase rejects undefined values, so drop them
  const row = Object.fromEntries(Object.entries({ ...rest, photoPath, ts: ServerValue.TIMESTAMP }).filter(([, v]) => v !== undefined))
  try {
    await node.set(row)
  } catch (e) {
    if (photoPath) await sb().storage.from(BUCKET).remove([photoPath]).catch(() => {})
    throw e
  }
  return id
}
