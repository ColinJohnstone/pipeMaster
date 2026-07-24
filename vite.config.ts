import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Emit bundled workers (the pdf.js worker) as CLASSIC scripts, not ES-module
  // workers. A module worker — `new Worker(url, { type: 'module' })` — is
  // rejected by Safari < 15 and older Firefox/Chrome, which is why PDF import
  // failed for some users with a "cannot download" worker error. A classic
  // worker loads everywhere.
  worker: { format: 'iife' },
})
