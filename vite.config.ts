import { defineConfig } from 'vite'

export default defineConfig({
  worker: { format: 'es' },
  server: { port: 5190 },
  build: { chunkSizeWarningLimit: 900 },
})
