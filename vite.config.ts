import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

function findComfyUI(): string | null {
  // Check environment variable first
  if (process.env.COMFYUI_PATH && existsSync(process.env.COMFYUI_PATH)) {
    return process.env.COMFYUI_PATH
  }
  // Check common locations
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    resolve(home, 'ComfyUI'),
    resolve(home, 'Desktop/ComfyUI'),
    resolve(home, 'Documents/ComfyUI'),
    'C:\\ComfyUI',
  ]
  for (const p of candidates) {
    if (existsSync(resolve(p, 'main.py'))) return p
  }
  return null
}

function comfyLauncher(): Plugin {
  let comfyProcess: ReturnType<typeof spawn> | null = null

  return {
    name: 'comfy-launcher',
    configureServer(server) {
      server.middlewares.use('/local-api/start-comfyui', (_req, res) => {
        if (comfyProcess && !comfyProcess.killed) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'already_running' }))
          return
        }

        const comfyPath = findComfyUI()
        if (!comfyPath) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'not_found', message: 'ComfyUI not found. Set COMFYUI_PATH in .env file.' }))
          return
        }

        try {
          comfyProcess = spawn('python', ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
            detached: true,
            stdio: 'ignore',
            cwd: comfyPath,
          })
          comfyProcess.unref()

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'started', path: comfyPath }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: String(err) }))
        }
      })

      server.middlewares.use('/local-api/comfyui-status', async (_req, res) => {
        try {
          const check = await fetch('http://localhost:8188/system_stats')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ running: check.ok }))
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ running: false }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), comfyLauncher()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:11434',
        changeOrigin: true,
      },
      '/ollama-search': {
        target: 'https://ollama.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama-search/, '/search'),
      },
      '/comfyui': {
        target: 'http://localhost:8188',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/comfyui/, ''),
        ws: true,
      },
    },
  },
})
