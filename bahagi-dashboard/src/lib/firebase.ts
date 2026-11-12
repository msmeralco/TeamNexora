import { initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously, type User } from 'firebase/auth'
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database'
import { config } from '../config'

let app: FirebaseApp | null = null
let database: Database | null = null
let signedIn: Promise<User> | null = null

function init() {
  if (app) return app
  const c = config.firebase
  if (!c.databaseURL || !c.apiKey)
    throw new Error('Firebase is not configured. Fill in the VITE_FIREBASE_* values in .env, or set VITE_USE_MOCK=true.')
  app = initializeApp(c)
  // local Firebase emulators (firebase emulators:start): VITE_FIREBASE_EMULATOR=127.0.0.1
  const emu = config.firebaseEmulator
  if (emu) {
    connectDatabaseEmulator(getDatabase(app), emu, 9000)
    connectAuthEmulator(getAuth(app), `http://${emu}:9099`, { disableWarnings: true })
  }
  return app
}

/** The Realtime Database. Created on first use so mock mode never needs Firebase settings. */
export function db(): Database {
  if (!database) database = getDatabase(init())
  return database
}

/**
 * Signs this browser in anonymously (once; Firebase keeps the same uid in this browser).
 * The database rules only let signed-in users read, and only uids listed under /dispatchers approve or restore.
 */
export function signIn(): Promise<User> {
  if (signedIn) return signedIn
  let auth: ReturnType<typeof getAuth>
  try { auth = getAuth(init()) } catch (e) { return Promise.reject(e) }
  signedIn = new Promise<User>((resolve, reject) => {
    const off = onAuthStateChanged(auth, (u) => {
      if (u) { off(); resolve(u) }
    })
    if (!auth.currentUser)
      signInAnonymously(auth).catch((e) => {
        off(); signedIn = null
        reject(new Error(`Firebase sign-in failed (${e.code ?? e.message}). Turn on Anonymous sign-in in Firebase → Authentication.`))
      })
  })
  return signedIn
}
