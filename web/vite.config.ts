import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev mode (npm run dev in web/) forwards API calls to the Node server.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:4817' } },
})
