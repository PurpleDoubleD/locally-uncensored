import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globals: true,
    environment: 'node',
    // dev-server/ kam mit ZB-7 dazu: der Dev-Server lag bis dahin in
    // vite.config.ts und war damit fuer vitest unsichtbar. Die Tests dort
    // haengen die ECHTEN Handler an einen echten node:http-Server.
    include: ['src/**/__tests__/**/*.test.ts', 'dev-server/**/__tests__/**/*.test.ts'],
  },
})
