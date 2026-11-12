import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // /api → the BAHAGI backend on this laptop (START_BAHAGI.bat) when VITE_USE_MOCK=false
  server: { proxy: { '/api': { target: 'http://localhost:8000', changeOrigin: true } } },
})
