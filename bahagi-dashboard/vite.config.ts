import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Point /api at your backend (API Gateway / local server) when VITE_USE_MOCK=false
  server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } },
})
