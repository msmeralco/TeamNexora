export interface Env {
  // secrets (npx wrangler secret put NAME)
  VERIFY_TOKEN: string
  APP_SECRET: string
  PAGE_ACCESS_TOKEN: string
  FIREBASE_SERVICE_ACCOUNT?: string // whole service-account .json (recommended)
  FIREBASE_DB_SECRET?: string // legacy database secret, used only if no service account
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string // sb_secret_... or legacy service_role key
  AWS_ACCESS_KEY_ID: string
  AWS_SECRET_ACCESS_KEY: string
  // vars (wrangler.toml)
  FIREBASE_DATABASE_URL: string
  AWS_REGION: string
  BEDROCK_MODEL_ID: string
  DEPTH_SCALE?: string
  SUPABASE_BUCKET?: string
  GRAPH_VERSION?: string
}
