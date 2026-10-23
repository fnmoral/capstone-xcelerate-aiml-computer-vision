import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev`: forward /api to the backend API (backend-module, published on 127.0.0.1:8100).
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8100', changeOrigin: true },
    },
  },
})
