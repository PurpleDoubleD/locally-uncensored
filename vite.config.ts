import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, createWriteStream, mkdirSync, statSync } from 'fs'
import { resolve, join, basename } from 'path'
import https from 'https'
import http from 'http'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import os from 'os'

// Load .env file from project root
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '.env') })

function findComfyUI(): string | null {
  // 1. Check .env / environment variable
  const envPath = process.env.COMFYUI_PATH
  console.log(`[ComfyUI] COMFYUI_PATH env: ${envPath || '(not set)'}`)
  if (envPath) {
    // Try the path directly (handles spaces in paths)
    const mainPy = join(envPath, 'main.py')
    console.log(`[ComfyUI] Checking: ${mainPy} -> ${existsSync(mainPy)}`)
    if (existsSync(mainPy)) return envPath
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  // 2. Check common locations
  const fixed = [
    resolve(home, 'ComfyUI'),
    resolve(home, 'Desktop/ComfyUI'),
    resolve(home, 'Documents/ComfyUI'),
    'C:\\ComfyUI',
  ]
  for (const p of fixed) {
    if (existsSync(resolve(p, 'main.py'))) return p
  }
  // 3. Recursive scan Desktop, Documents, and drive roots (up to 4 levels deep)
  const scanRoots = [
    resolve(home, 'Desktop'),
    resolve(home, 'Documents'),
    resolve(home, 'Downloads'),
    ...(process.platform === 'win32' ? ['C:\\', 'D:\\'] : ['/opt', '/usr/local']),
  ]
  const skipNames = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'site-packages', 'Windows', 'Program Files', 'Program Files (x86)', '$Recycle.Bin', 'AppData'])

  function scanForComfyUI(dir: string, depth: number): string | null {
    if (depth <= 0) return null
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || skipNames.has(entry.name)) continue
        const full = join(dir, entry.name)
        // Check if this directory IS ComfyUI (has main.py + folder named ComfyUI or contains comfy-specific files)
        if (entry.name === 'ComfyUI' || entry.name === 'comfyui') {
          if (existsSync(join(full, 'main.py'))) return full
        }
        // Recurse deeper
        const found = scanForComfyUI(full, depth - 1)
        if (found) return found
      }
    } catch { /* skip unreadable dirs */ }
    return null
  }

  for (const root of scanRoots) {
    if (!existsSync(root)) continue
    const found = scanForComfyUI(root, 4)
    if (found) return found
  }
  return null
}

// Shared Python binary resolver — filters Windows Store alias, caches result
const pythonBin = (() => {
  if (process.platform !== 'win32') return 'python3'
  try {
    const paths = execSync('where python', { encoding: 'utf8' }).trim().split('\n')
    const real = paths.find((p: string) => !p.includes('WindowsApps'))
    return real ? real.trim() : 'python'
  } catch { return 'python' }
})()
console.log(`[Python] Resolved: ${pythonBin}`)

function isComfyRunning(): Promise<boolean> {
  return fetch('http://localhost:8188/system_stats')
    .then(r => r.ok)
    .catch(() => false)
}

function comfyLauncher(): Plugin {
  let comfyProcess: ChildProcess | null = null
  let comfyLogs: string[] = []

  const startComfy = (comfyPath: string): { status: string; path: string } => {
    if (comfyProcess && !comfyProcess.killed) {
      return { status: 'already_running', path: comfyPath }
    }

    comfyLogs = []
    console.log(`[ComfyUI] Spawning ${pythonBin} in: ${comfyPath}`)
    comfyProcess = spawn(pythonBin, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
      cwd: comfyPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    comfyProcess.stdout?.on('data', (d) => {
      const line = d.toString()
      comfyLogs.push(line)
      if (comfyLogs.length > 200) comfyLogs.shift()
    })
    comfyProcess.stderr?.on('data', (d) => {
      const line = d.toString()
      comfyLogs.push(line)
      if (comfyLogs.length > 200) comfyLogs.shift()
    })
    comfyProcess.on('exit', () => { comfyProcess = null })

    console.log(`[ComfyUI] Starting from: ${comfyPath}`)
    return { status: 'started', path: comfyPath }
  }

  const stopComfy = () => {
    if (comfyProcess && !comfyProcess.killed) {
      // Kill process tree on Windows
      try {
        if (process.platform === 'win32' && comfyProcess.pid) {
          execSync(`taskkill /pid ${comfyProcess.pid} /T /F`, { stdio: 'ignore' })
        } else {
          comfyProcess.kill('SIGTERM')
        }
      } catch { /* already dead */ }
      comfyProcess = null
      console.log('[ComfyUI] Stopped')
    }
  }

  return {
    name: 'comfy-launcher',
    configureServer(server) {
      // --- Security Middleware ---
      server.middlewares.use('/local-api', (req, res, next) => {
        // Exclude GET proxy-image/download from strict header checks (used in <img> tags and simple fetches)
        if (req.method === 'GET' && (req.url?.startsWith('/proxy-image') || req.url?.startsWith('/proxy-download'))) {
          return next();
        }

        // 1. Strict Content-Type enforcement for POST requests
        if (req.method === 'POST') {
           const contentType = req.headers['content-type'] || '';
           if (!contentType.includes('application/json')) {
               res.writeHead(415, { 'Content-Type': 'text/plain' });
               res.end('Unsupported Media Type: Must be application/json');
               return;
           }
        }
        
        // 2. Custom Header Requirement (CSRF Protection)
        if (req.headers['x-locally-uncensored'] !== 'true') {
           res.writeHead(403, { 'Content-Type': 'text/plain' });
           res.end('Forbidden: Missing x-locally-uncensored header (CSRF Protection)');
           return;
        }

        // 3. Strict Origin Validation (Defense in Depth)
        const origin = req.headers.origin;
        if (origin) {
            const allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost'];
            if (!allowedOrigins.includes(origin)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden: Invalid Origin (CSRF Protection)');
                return;
            }
        }

        next();
      });

      // Auto-start Ollama when dev server starts
      try {
        execSync('tasklist /FI "IMAGENAME eq ollama.exe" | find /I "ollama.exe"', { stdio: 'ignore' })
        console.log('[Ollama] Already running')
      } catch {
        console.log('[Ollama] Starting...')
        try {
          const ollamaProc = spawn('ollama', ['serve'], {
            detached: true,
            stdio: 'ignore',
            shell: false,
            windowsHide: true,
          })
          ollamaProc.unref()
          console.log('[Ollama] Started')
        } catch (err) {
          console.warn('[Ollama] Failed to start:', err)
        }
      }

      // Auto-start ComfyUI when dev server starts
      setTimeout(async () => {
        try {
          const running = await isComfyRunning()
          if (!running) {
            const comfyPath = findComfyUI()
            if (comfyPath) {
              console.log(`[ComfyUI] Auto-starting from: ${comfyPath}`)
              const result = startComfy(comfyPath)
              console.log(`[ComfyUI] Start result: ${result.status}`)
            } else {
              console.log('[ComfyUI] Not found. Set COMFYUI_PATH in .env or install ComfyUI.')
            }
          } else {
            console.log('[ComfyUI] Already running on port 8188')
          }
        } catch (err) {
          console.error('[ComfyUI] Auto-start error:', err)
        }
      }, 1000)

      // Auto-stop ComfyUI when dev server closes
      server.httpServer?.on('close', stopComfy)
      process.on('exit', stopComfy)
      process.on('SIGINT', () => { stopComfy(); process.exit() })
      process.on('SIGTERM', () => { stopComfy(); process.exit() })

      // API: ComfyUI POST proxy (workaround for Vite 8 blocking POST via proxy)
      server.middlewares.use('/comfyui', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const targetPath = (req.url || '').replace(/^\/comfyui/, '') || '/'
        let body = ''
        req.on('data', (chunk: any) => { body += chunk })
        req.on('end', () => {
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: 8188,
            path: targetPath,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (proxyRes) => {
            const chunks: Buffer[] = []
            proxyRes.on('data', (c: Buffer) => chunks.push(c))
            proxyRes.on('end', () => {
              const responseBody = Buffer.concat(chunks).toString()
              res.writeHead(proxyRes.statusCode || 500, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/json',
              })
              res.end(responseBody)
            })
          })
          proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          })
          proxyReq.write(body)
          proxyReq.end()
        })
      })

      // API: Privacy image proxy — prevents external servers from tracking users
      server.middlewares.use('/local-api/proxy-image', (req, res) => {
        const imgUrl = new URL(req.url || '', 'http://localhost').searchParams.get('url')
        if (!imgUrl) { res.writeHead(400); res.end(); return }
        const proto = imgUrl.startsWith('https') ? https : http
        proto.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (upstream) => {
          if (upstream.statusCode && upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
            proto.get(upstream.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (redir) => {
              res.writeHead(redir.statusCode || 200, {
                'Content-Type': redir.headers['content-type'] || 'image/jpeg',
                'Cache-Control': 'public, max-age=86400',
              })
              redir.pipe(res)
            }).on('error', () => { res.writeHead(502); res.end() })
            return
          }
          res.writeHead(upstream.statusCode || 200, {
            'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          })
          upstream.pipe(res)
        }).on('error', () => { res.writeHead(502); res.end() })
      })

      // API: Proxy download (follows redirects server-side, avoids CORS)
      server.middlewares.use('/local-api/proxy-download', (req, res) => {
        const url = new URL(req.url || '', 'http://localhost').searchParams.get('url')
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing url parameter' }))
          return
        }

        const protocol = url.startsWith('https') ? https : http
        const fetchUrl = (targetUrl: string, redirectCount = 0) => {
          if (redirectCount > 5) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Too many redirects' }))
            return
          }
          protocol.get(targetUrl, { headers: { 'User-Agent': 'LocallyUncensored/1.0' } }, (upstream) => {
            if (upstream.statusCode && upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
              fetchUrl(upstream.headers.location, redirectCount + 1)
              return
            }
            res.writeHead(upstream.statusCode || 200, {
              'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
              'Content-Length': upstream.headers['content-length'] || '',
            })
            upstream.pipe(res)
          }).on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          })
        }
        fetchUrl(url)
      })

      // API: Manual start
      server.middlewares.use('/local-api/start-comfyui', async (_req, res) => {
        const alreadyRunning = await isComfyRunning()
        if (alreadyRunning) {
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
          const result = startComfy(comfyPath)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: String(err) }))
        }
      })

      // API: Stop
      server.middlewares.use('/local-api/stop-comfyui', (_req, res) => {
        stopComfy()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'stopped' }))
      })

      // ─── Model Download Manager ───
      const activeDownloads = new Map<string, { progress: number; total: number; speed: number; filename: string; status: string; error?: string }>()

      function downloadFile(url: string, destPath: string, id: string): Promise<void> {
        return new Promise((promiseResolve, promiseReject) => {
          const filename = basename(destPath)
          activeDownloads.set(id, { progress: 0, total: 0, speed: 0, filename, status: 'connecting' })

          const doRequest = (requestUrl: string, redirectCount = 0) => {
            if (redirectCount > 5) { promiseReject(new Error('Too many redirects')); return }
            const proto = requestUrl.startsWith('https') ? https : http
            proto.get(requestUrl, { headers: { 'User-Agent': 'LocallyUncensored/1.1' } }, (response) => {
              if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                doRequest(response.headers.location, redirectCount + 1)
                return
              }
              if (response.statusCode !== 200) {
                activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: `HTTP ${response.statusCode}` })
                promiseReject(new Error(`HTTP ${response.statusCode}`))
                return
              }

              const total = parseInt(response.headers['content-length'] || '0', 10)
              let downloaded = 0
              let lastTime = Date.now()
              let lastBytes = 0

              const dir = dirname(destPath)
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
              const file = createWriteStream(destPath)

              activeDownloads.set(id, { progress: 0, total, speed: 0, filename, status: 'downloading' })

              response.on('data', (chunk: Buffer) => {
                downloaded += chunk.length
                const now = Date.now()
                const dt = (now - lastTime) / 1000
                if (dt >= 1) {
                  const speed = (downloaded - lastBytes) / dt
                  lastTime = now
                  lastBytes = downloaded
                  activeDownloads.set(id, { progress: downloaded, total, speed, filename, status: 'downloading' })
                }
              })

              response.pipe(file)
              file.on('finish', () => {
                file.close()
                activeDownloads.set(id, { progress: total || downloaded, total: total || downloaded, speed: 0, filename, status: 'complete' })
                console.log(`[Download] Complete: ${filename}`)
                promiseResolve()
              })
              file.on('error', (err) => {
                activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: err.message })
                promiseReject(err)
              })
            }).on('error', (err) => {
              activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: err.message })
              promiseReject(err)
            })
          }
          doRequest(url)
        })
      }

      // API: Start a model download
      server.middlewares.use('/local-api/download-model', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { url, subfolder, filename, expectedBytes } = JSON.parse(body)
            if (!url || !subfolder || !filename) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing url, subfolder, or filename' }))
              return
            }
            const comfyPath = findComfyUI()
            if (!comfyPath) {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'ComfyUI not found' }))
              return
            }
            const destDir = subfolder.startsWith('custom_nodes/') || subfolder.startsWith('custom_nodes\\')
              ? join(comfyPath, subfolder)
              : join(comfyPath, 'models', subfolder)
            const destPath = join(destDir, filename)

            if (existsSync(destPath)) {
              // Validate file size if expectedBytes provided (catch partial downloads)
              let fileComplete = true
              if (expectedBytes && expectedBytes > 0) {
                try {
                  const actual = statSync(destPath).size
                  const threshold = expectedBytes * 0.9
                  fileComplete = actual >= threshold
                  if (!fileComplete) {
                    console.log(`[Download] File ${filename} is incomplete: ${actual} bytes vs ${expectedBytes} expected (${Math.round(actual / expectedBytes * 100)}%)`)
                  }
                } catch { fileComplete = true }
              }
              if (fileComplete) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ status: 'exists', id: filename }))
                return
              }
              // Fall through to re-download incomplete file
            }

            const id = filename
            console.log(`[Download] Starting: ${filename} → ${destDir}`)
            downloadFile(url, destPath, id).catch(err => console.error(`[Download] Failed: ${err.message}`))

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'started', id }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: Download progress
      server.middlewares.use('/local-api/download-progress', (_req, res) => {
        const downloads: Record<string, any> = {}
        for (const [id, info] of activeDownloads.entries()) {
          downloads[id] = info
          if (info.status === 'complete' || info.status === 'error') {
            setTimeout(() => activeDownloads.delete(id), 30000)
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(downloads))
      })

      // API: Detect model path for non-Ollama providers (LM Studio, etc.)
      server.middlewares.use('/local-api/detect-model-path', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { provider } = JSON.parse(body)
            // Try common paths for LM Studio / other providers
            const { existsSync } = require('fs')
            const { join } = require('path')
            const home = require('os').homedir()
            const candidates = [
              join(home, '.cache', 'lm-studio', 'models'),
              join(home, 'AppData', 'Local', 'LM Studio', 'models'),
              join(home, '.local', 'share', 'lm-studio', 'models'),
            ]
            const found = candidates.find(p => existsSync(p))
            if (found) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(found))
            } else {
              // Fallback: create LU models directory (same as Rust backend)
              const { mkdirSync } = require('fs')
              const fallback = join(home, 'locally-uncensored', 'models')
              try { mkdirSync(fallback, { recursive: true }) } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(fallback))
            }
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(null))
          }
        })
      })

      // API: Check model file sizes (for partial download detection)
      server.middlewares.use('/local-api/check-model-sizes', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { files } = JSON.parse(body)
            const { existsSync, statSync } = require('fs')
            const { join } = require('path')
            const home = require('os').homedir()
            // Try to find ComfyUI path
            const candidates = [
              join(home, 'ComfyUI'),
              join(home, 'Desktop', 'ComfyUI'),
              'C:\\ComfyUI',
            ]
            const comfyPath = candidates.find(p => existsSync(p)) || join(home, 'ComfyUI')
            const results = (files as any[]).map((f: any) => {
              const subfolder = f.subfolder || ''
              const dir = subfolder.startsWith('custom_nodes')
                ? join(comfyPath, subfolder)
                : join(comfyPath, 'models', subfolder)
              const filePath = join(dir, f.filename)
              if (existsSync(filePath)) {
                const actual = statSync(filePath).size
                const threshold = f.expectedBytes > 0 ? f.expectedBytes * 0.9 : 0
                return { filename: f.filename, exists: true, actualBytes: actual, complete: f.expectedBytes === 0 || actual >= threshold }
              }
              return { filename: f.filename, exists: false, actualBytes: 0, complete: false }
            })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(results))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: Download model to a specific path (for HuggingFace GGUF → LM Studio etc.)
      server.middlewares.use('/local-api/download-model-to-path', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            const url = parsed.url
            const destDir = parsed.destDir || parsed.dest_dir
            const filename = parsed.filename
            if (!url || !destDir || !filename) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing url, destDir, or filename' }))
              return
            }
            const { existsSync, mkdirSync, statSync: statSyncFs } = require('fs')
            const { join } = require('path')
            const expectedBytes = parsed.expectedBytes
            if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
            const destPath = join(destDir, filename)
            if (existsSync(destPath)) {
              let fileComplete = true
              if (expectedBytes && expectedBytes > 0) {
                try {
                  const actual = statSyncFs(destPath).size
                  fileComplete = actual >= expectedBytes * 0.9
                  if (!fileComplete) console.log(`[Download] ${filename} incomplete: ${actual} vs ${expectedBytes} expected`)
                } catch { fileComplete = true }
              }
              if (fileComplete) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ status: 'exists', id: filename }))
                return
              }
            }
            const id = filename
            console.log(`[Download] Starting to path: ${filename} → ${destDir}`)
            downloadFile(url, destPath, id).catch(err => console.error(`[Download] Failed: ${err.message}`))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'started', id }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: Pause download (dev mode stub — sets status to paused)
      server.middlewares.use('/local-api/pause-download', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          const { id } = JSON.parse(body)
          const dl = activeDownloads.get(id)
          if (dl) dl.status = 'paused'
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'paused' }))
        })
      })

      // API: Cancel download (dev mode stub — removes from map)
      server.middlewares.use('/local-api/cancel-download', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          const { id } = JSON.parse(body)
          activeDownloads.delete(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'cancelled' }))
        })
      })

      // API: Resume download (dev mode stub — restarts download)
      server.middlewares.use('/local-api/resume-download', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          const { id, url, subfolder } = JSON.parse(body)
          if (url && subfolder) {
            const comfyPath = findComfyUI()
            if (comfyPath) {
              const destPath = join(comfyPath, 'models', subfolder, id)
              downloadFile(url, destPath, id).catch(err => console.error(`[Download] Resume failed: ${err.message}`))
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'resuming' }))
        })
      })

      // API: Install custom node (git clone into ComfyUI/custom_nodes/)
      server.middlewares.use('/local-api/install-custom-node', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const _parsed = JSON.parse(body)
            const repo_url = _parsed.repoUrl || _parsed.repo_url
            const node_name = _parsed.nodeName || _parsed.node_name
            const comfyPath = findComfyUI()
            if (!comfyPath) {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'ComfyUI not found. Install ComfyUI first.' }))
              return
            }
            const customNodesDir = join(comfyPath, 'custom_nodes')
            if (!existsSync(customNodesDir)) mkdirSync(customNodesDir, { recursive: true })
            const targetDir = join(customNodesDir, node_name || basename(repo_url, '.git'))
            if (existsSync(targetDir)) {
              console.log(`[CustomNode] Already installed: ${node_name}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'already_installed', path: targetDir }))
              return
            }
            console.log(`[CustomNode] Installing ${node_name} from ${repo_url}...`)
            try {
              execSync(`git clone "${repo_url}" "${targetDir}"`, { timeout: 120000 })
              // Try pip install if requirements.txt exists
              const reqFile = join(targetDir, 'requirements.txt')
              if (existsSync(reqFile)) {
                try {
                  execSync(`pip install -r "${reqFile}"`, { cwd: targetDir, timeout: 300000 })
                } catch (pipErr: any) {
                  console.warn(`[CustomNode] pip install failed for ${node_name}:`, pipErr.message)
                }
              }
              console.log(`[CustomNode] Installed: ${node_name}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'installed', path: targetDir }))
            } catch (gitErr: any) {
              console.error(`[CustomNode] Git clone failed:`, gitErr.message)
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `Git clone failed: ${gitErr.message}` }))
            }
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: Set ComfyUI path (writes to .env and starts ComfyUI)
      server.middlewares.use('/local-api/set-comfyui-path', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: newPath } = JSON.parse(body)
            const mainPy = join(newPath, 'main.py')
            if (!existsSync(mainPy)) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'error', error: `main.py not found in "${newPath}". Make sure this is the ComfyUI root folder.` }))
              return
            }

            // Write to .env file
            const envPath = resolve(__dirname, '.env')
            const { writeFileSync, readFileSync } = require('fs')
            let envContent = ''
            try { envContent = readFileSync(envPath, 'utf8') } catch { /* no .env yet */ }

            if (envContent.includes('COMFYUI_PATH=')) {
              envContent = envContent.replace(/COMFYUI_PATH=.*/g, `COMFYUI_PATH=${newPath}`)
            } else {
              envContent += `${envContent.endsWith('\n') ? '' : '\n'}COMFYUI_PATH=${newPath}\n`
            }
            writeFileSync(envPath, envContent, 'utf8')

            // Update process.env
            process.env.COMFYUI_PATH = newPath
            console.log(`[ComfyUI] Path set to: ${newPath}`)

            // Auto-start ComfyUI
            const result = startComfy(newPath)
            console.log(`[ComfyUI] Start result: ${result.status}`)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', path: newPath }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'error', error: String(err) }))
          }
        })
      })

      // API: Install ComfyUI from scratch
      const installLogs: string[] = []
      let installStatus: 'idle' | 'installing' | 'complete' | 'error' = 'idle'
      let installError = ''

      server.middlewares.use('/local-api/install-comfyui', (req, res) => {
        if (req.method === 'GET') {
          // Return install status
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: installStatus, error: installError, logs: installLogs.slice(-30) }))
          return
        }
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

        if (installStatus === 'installing') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'already_installing' }))
          return
        }

        // Check Python is available
        try {
          execSync('python --version', { stdio: 'ignore' })
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', error: 'Python not found. Install Python 3.10+ from python.org first.' }))
          return
        }

        installStatus = 'installing'
        installError = ''
        installLogs.length = 0

        const home = process.env.USERPROFILE || process.env.HOME || ''
        const installDir = join(home, 'ComfyUI')

        const log = (msg: string) => {
          installLogs.push(msg)
          if (installLogs.length > 200) installLogs.shift()
          console.log(`[ComfyUI Install] ${msg}`)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'started', path: installDir }))

        // Run installation in background
        ;(async () => {
          try {
            // Step 1: Clone
            if (!existsSync(installDir)) {
              log('Cloning ComfyUI from GitHub...')
              const clone = spawn('git', ['clone', 'https://github.com/comfyanonymous/ComfyUI.git', installDir], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
              clone.stdout?.on('data', (d) => log(d.toString().trim()))
              clone.stderr?.on('data', (d) => log(d.toString().trim()))
              await new Promise<void>((resolve, reject) => {
                clone.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`git clone failed (exit ${code})`)))
              })
              log('Clone complete.')
            } else if (existsSync(join(installDir, 'main.py'))) {
              log('ComfyUI directory already exists, skipping clone.')
            } else {
              throw new Error(`${installDir} exists but is not ComfyUI. Delete it or choose another location.`)
            }

            // Step 2: Install Python dependencies
            log('Installing Python dependencies (this may take several minutes)...')
            const pip = spawn('pip', ['install', '-r', 'requirements.txt'], { cwd: installDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
            pip.stdout?.on('data', (d) => {
              const lines = d.toString().split('\n').filter((l: string) => l.trim())
              lines.forEach((l: string) => log(l.trim()))
            })
            pip.stderr?.on('data', (d) => {
              const lines = d.toString().split('\n').filter((l: string) => l.trim())
              lines.forEach((l: string) => log(l.trim()))
            })
            await new Promise<void>((resolve, reject) => {
              pip.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`pip install failed (exit ${code})`)))
            })
            log('Dependencies installed.')

            // Step 3: Install PyTorch with CUDA (if NVIDIA GPU detected)
            log('Checking for NVIDIA GPU...')
            let hasNvidia = false
            try {
              execSync('nvidia-smi', { stdio: 'ignore' })
              hasNvidia = true
            } catch { /* no nvidia */ }

            if (hasNvidia) {
              log('NVIDIA GPU found. Installing PyTorch with CUDA support...')
              const torch = spawn('pip', ['install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu121'], { cwd: installDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
              torch.stdout?.on('data', (d) => log(d.toString().trim()))
              torch.stderr?.on('data', (d) => log(d.toString().trim()))
              await new Promise<void>((resolve, reject) => {
                torch.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`PyTorch CUDA install failed (exit ${code})`)))
              })
              log('PyTorch with CUDA installed.')
            } else {
              log('No NVIDIA GPU — using CPU PyTorch (already in requirements).')
            }

            // Step 4: Save path to .env
            const envPath = resolve(__dirname, '.env')
            const { writeFileSync, readFileSync } = require('fs')
            let envContent = ''
            try { envContent = readFileSync(envPath, 'utf8') } catch { /* no .env */ }
            if (envContent.includes('COMFYUI_PATH=')) {
              envContent = envContent.replace(/COMFYUI_PATH=.*/g, `COMFYUI_PATH=${installDir}`)
            } else {
              envContent += `${envContent.endsWith('\n') ? '' : '\n'}COMFYUI_PATH=${installDir}\n`
            }
            writeFileSync(envPath, envContent, 'utf8')
            process.env.COMFYUI_PATH = installDir
            log(`Path saved to .env: ${installDir}`)

            // Step 5: Start ComfyUI
            log('Starting ComfyUI...')
            startComfy(installDir)
            log('ComfyUI started! You can now download models and generate images/videos.')

            installStatus = 'complete'
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log(`ERROR: ${msg}`)
            installError = msg
            installStatus = 'error'
          }
        })()
      })

      // API: Status + logs
      server.middlewares.use('/local-api/comfyui-status', async (_req, res) => {
        let running = false
        try { running = await isComfyRunning() } catch { /* ignore */ }
        const comfyPath = findComfyUI()
        const processAlive = comfyProcess !== null && !comfyProcess.killed
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          running,
          starting: processAlive && !running,
          found: comfyPath !== null,
          path: comfyPath,
          logs: comfyLogs.slice(-20),
          processAlive,
        }))
      })

      // --- Agent Tool Endpoints ---

      // API: Execute Python code
      server.middlewares.use('/local-api/execute-code', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { code, timeout: timeoutMs } = JSON.parse(body)
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing code parameter' }))
              return
            }

            const os = require('os')
            const fs = require('fs')
            const tmpDir = join(os.tmpdir(), 'agent-exec-' + Date.now())
            fs.mkdirSync(tmpDir, { recursive: true })

            const limit = timeoutMs || 30000
            let stdout = ''
            let stderr = ''
            let killed = false

            const pythonBin = (() => {
              if (process.platform !== 'win32') return 'python3'
              try {
                const { execSync } = require('child_process')
                const paths = execSync('where python', { encoding: 'utf8' }).trim().split('\n')
                const real = paths.find((p) => !p.includes('WindowsApps'))
                return real ? '"' + real.trim() + '"' : 'python'
              } catch { return 'python' }
            })()
            const proc = spawn(pythonBin, ['-c', code], {
              cwd: tmpDir,
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: false,
            })

            const timer = setTimeout(() => {
              killed = true
              try { proc.kill('SIGKILL') } catch { /* already dead */ }
            }, limit)

            proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
            proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

            proc.on('exit', (exitCode) => {
              clearTimeout(timer)
              try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }

              if (killed) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ stdout: '', stderr: 'Execution timed out', exitCode: 124 }))
                return
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ stdout, stderr, exitCode: exitCode ?? 1 }))
            })

            proc.on('error', (err: Error) => {
              clearTimeout(timer)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ stdout: '', stderr: err.message, exitCode: 1 }))
            })
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: Read file from agent workspace
      server.middlewares.use('/local-api/file-read', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: filePath } = JSON.parse(body)
            if (!filePath || filePath.includes('..')) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid path' }))
              return
            }

            const os = require('os')
            const fs = require('fs')
            const workspaceDir = join(os.homedir(), 'agent-workspace')
            if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true })

            const resolvedPath = join(workspaceDir, filePath)
            try {
              const content = fs.readFileSync(resolvedPath, 'utf8')
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ content }))
            } catch {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'File not found' }))
            }
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: Write file to agent workspace
      server.middlewares.use('/local-api/file-write', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: filePath, content } = JSON.parse(body)
            if (!filePath || filePath.includes('..')) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid path' }))
              return
            }
            if (content === undefined) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing content parameter' }))
              return
            }

            const os = require('os')
            const fs = require('fs')
            const workspaceDir = join(os.homedir(), 'agent-workspace')
            const resolvedPath = join(workspaceDir, filePath)
            const parentDir = resolve(resolvedPath, '..')
            if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })

            fs.writeFileSync(resolvedPath, content, 'utf8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', path: resolvedPath }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // --- New Agent Tool Endpoints (Phase 1) ---

      // API: Shell execute
      server.middlewares.use('/local-api/shell-execute', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { command, cwd, timeout: timeoutMs, shell: shellType } = JSON.parse(body)
            if (!command) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing command' }))
              return
            }

            const shellBin = shellType || (process.platform === 'win32' ? 'powershell' : 'bash')
            const shellArgs: string[] = []
            if (shellBin.includes('powershell')) {
              shellArgs.push('-NoProfile', '-NonInteractive', '-Command', command)
            } else if (shellBin.includes('cmd')) {
              shellArgs.push('/C', command)
            } else {
              shellArgs.push('-c', command)
            }

            const limit = timeoutMs || 120000
            let stdout = ''
            let stderr = ''
            let killed = false

            const proc = spawn(shellBin, shellArgs, {
              cwd: cwd || undefined,
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: false,
            })

            const timer = setTimeout(() => {
              killed = true
              try { proc.kill('SIGKILL') } catch { /* dead */ }
            }, limit)

            proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
            proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

            proc.on('exit', (exitCode) => {
              clearTimeout(timer)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                stdout, stderr,
                exitCode: killed ? -1 : (exitCode ?? 1),
                timedOut: killed,
              }))
            })

            proc.on('error', (err: Error) => {
              clearTimeout(timer)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ stdout: '', stderr: err.message, exitCode: 1, timedOut: false }))
            })
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: FS read (unsandboxed)
      server.middlewares.use('/local-api/fs-read', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: filePath } = JSON.parse(body)
            const os = require('os')
            const fs = require('fs')
            const resolved = require('path').isAbsolute(filePath) ? filePath : join(os.homedir(), 'agent-workspace', filePath)
            const content = fs.readFileSync(resolved, 'utf8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ content, encoding: 'utf8' }))
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: FS write (unsandboxed)
      server.middlewares.use('/local-api/fs-write', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: filePath, content } = JSON.parse(body)
            const os = require('os')
            const fs = require('fs')
            const resolved = require('path').isAbsolute(filePath) ? filePath : join(os.homedir(), 'agent-workspace', filePath)
            const parentDir = resolve(resolved, '..')
            if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
            fs.writeFileSync(resolved, content, 'utf8')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'saved', path: resolved }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: FS list
      server.middlewares.use('/local-api/fs-list', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: dirPath, recursive } = JSON.parse(body)
            const os = require('os')
            const fs = require('fs')
            const resolved = require('path').isAbsolute(dirPath) ? dirPath : join(os.homedir(), 'agent-workspace', dirPath)
            const entries: any[] = []
            const items = fs.readdirSync(resolved, { withFileTypes: true })
            for (const item of items.slice(0, 500)) {
              const fullPath = join(resolved, item.name)
              try {
                const stat = fs.statSync(fullPath)
                entries.push({ name: item.name, path: fullPath, size: stat.size, isDir: item.isDirectory(), modified: Math.floor(stat.mtimeMs / 1000) })
              } catch { /* skip */ }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ entries, count: entries.length }))
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ entries: [], count: 0, error: String(err) }))
          }
        })
      })

      // API: FS search (grep-like)
      server.middlewares.use('/local-api/fs-search', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: dirPath, pattern, max_results } = JSON.parse(body)
            const os = require('os')
            const fs = require('fs')
            const resolved = require('path').isAbsolute(dirPath) ? dirPath : join(os.homedir(), 'agent-workspace', dirPath)
            const re = new RegExp(pattern)
            const results: any[] = []
            const max = max_results || 50

            function walkDir(dir: string, depth: number) {
              if (depth > 5 || results.length >= max) return
              try {
                for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                  const full = join(dir, item.name)
                  if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                    walkDir(full, depth + 1)
                  } else if (item.isFile()) {
                    try {
                      const stat = fs.statSync(full)
                      if (stat.size > 1000000) continue
                      const content = fs.readFileSync(full, 'utf8')
                      const matches: any[] = []
                      content.split('\n').forEach((line: string, i: number) => {
                        if (re.test(line) && matches.length < 10) {
                          matches.push({ line: i + 1, text: line.slice(0, 200) })
                        }
                      })
                      if (matches.length > 0) results.push({ file: full, matches })
                    } catch { /* skip binary */ }
                  }
                }
              } catch { /* permission denied */ }
            }
            walkDir(resolved, 0)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ results, count: results.length }))
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ results: [], count: 0, error: String(err) }))
          }
        })
      })

      // API: FS info
      server.middlewares.use('/local-api/fs-info', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { path: filePath } = JSON.parse(body)
            const os = require('os')
            const fs = require('fs')
            const resolved = require('path').isAbsolute(filePath) ? filePath : join(os.homedir(), 'agent-workspace', filePath)
            const stat = fs.statSync(resolved)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              path: resolved, size: stat.size, isDir: stat.isDirectory(), isFile: stat.isFile(),
              modified: Math.floor(stat.mtimeMs / 1000), created: Math.floor(stat.birthtimeMs / 1000),
              readonly: false,
            }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // API: System info
      server.middlewares.use('/local-api/system-info', (_req, res) => {
        const os = require('os')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          os: process.platform, arch: process.arch, hostname: os.hostname(),
          username: os.userInfo().username, totalMemory: os.totalmem(), cpuCount: os.cpus().length,
        }))
      })

      // API: Process list
      server.middlewares.use('/local-api/process-list', (_req, res) => {
        // Simple stub — full process list needs native code
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ processes: [], count: 0, note: 'Full process list available in Tauri build only' }))
      })

      // API: Screenshot
      server.middlewares.use('/local-api/screenshot', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Screenshot available in Tauri build only' }))
      })

      // --- SearXNG availability check ---
      let searxngAvailable = false
      const checkSearXNG = () => {
        const checkReq = http.get('http://localhost:8888/search?q=test&format=json', { timeout: 2000 }, (response) => {
          searxngAvailable = response.statusCode === 200
          console.log('[WebSearch] SearXNG ' + (searxngAvailable ? 'detected and available' : 'responded but returned non-200'))
          response.resume()
        })
        checkReq.on('error', () => {
          searxngAvailable = false
          console.log('[WebSearch] SearXNG not available (connection refused or timeout)')
        })
        checkReq.on('timeout', () => {
          checkReq.destroy()
          searxngAvailable = false
          console.log('[WebSearch] SearXNG not available (timeout)')
        })
      }
      checkSearXNG()

      // API: Search status (for frontend to check SearXNG availability)
      server.middlewares.use('/local-api/search-status', (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ searxng: searxngAvailable }))
      })


      // --- SearXNG One-Click Install ---
      const searxngInstallLogs: string[] = []
      let searxngInstallStatus: "idle" | "installing" | "complete" | "error" = "idle"
      let searxngInstallError = ""

      server.middlewares.use("/local-api/install-searxng", (req, res) => {
        if (req.method === "GET") {
          // Check Docker availability and container status
          let dockerAvailable = false
          let installed = false
          let running = false
          try {
            execSync("docker --version", { stdio: "ignore" })
            dockerAvailable = true
            try {
              const containerStatus = execSync("docker ps -a --filter name=^searxng$ --format \"{{.Status}}\"", { encoding: "utf8" }).trim()
              if (containerStatus) {
                installed = true
                running = containerStatus.toLowerCase().startsWith("up")
              }
            } catch { /* no container */ }
          } catch { /* no docker */ }

          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            installed,
            running,
            dockerAvailable,
            status: searxngInstallStatus,
            error: searxngInstallError,
            logs: searxngInstallLogs.slice(-30),
          }))
          return
        }
        if (req.method !== "POST") { res.writeHead(405); res.end(); return }

        if (searxngInstallStatus === "installing") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ status: "already_installing" }))
          return
        }

        // Check if Docker is available
        let postHasDocker = false
        try {
          execSync("docker --version", { stdio: "ignore" })
          postHasDocker = true
        } catch { /* no docker */ }

        if (!postHasDocker) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Docker is required for SearXNG. Install Docker first.", dockerMissing: true }))
          return
        }

        // Check if container already exists but is stopped — just restart it
        try {
          const existingStatus = execSync("docker ps -a --filter name=^searxng$ --format \"{{.Status}}\"", { encoding: "utf8" }).trim()
          if (existingStatus && !existingStatus.toLowerCase().startsWith("up")) {
            execSync("docker start searxng", { stdio: "ignore" })
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ status: "ok", message: "SearXNG restarted on port 8888" }))
            // Re-check availability after a short delay
            setTimeout(() => checkSearXNG(), 3000)
            return
          }
        } catch { /* no existing container */ }

        searxngInstallStatus = "installing"
        searxngInstallError = ""
        searxngInstallLogs.length = 0

        const home = process.env.HOME || ""
        const searxngDir = join(home, "searxng")

        const log = (msg: string) => {
          searxngInstallLogs.push(msg)
          if (searxngInstallLogs.length > 200) searxngInstallLogs.shift()
          console.log("[SearXNG Install] " + msg)
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "started", path: searxngDir }))

        // Run installation in background
        ;(async () => {
          try {
            // Create directory
            if (!existsSync(searxngDir)) {
              mkdirSync(searxngDir, { recursive: true })
              log("Created directory: " + searxngDir)
            }

            log("Pulling SearXNG image...")
            const pull = spawn("docker", ["pull", "searxng/searxng"], { shell: true, stdio: ["ignore", "pipe", "pipe"] })
            pull.stdout?.on("data", (d) => log(d.toString().trim()))
            pull.stderr?.on("data", (d) => log(d.toString().trim()))
            await new Promise<void>((resolve, reject) => {
              pull.on("exit", (code) => code === 0 ? resolve() : reject(new Error("docker pull failed (exit " + code + ")")))
            })
            log("Pull complete. Starting SearXNG container...")

            // Remove existing container if any
            try { execSync("docker rm -f searxng", { stdio: "ignore" }) } catch { /* no existing container */ }

            const run = spawn("docker", [
              "run", "-d", "--name", "searxng",
              "-p", "8888:8080",
              "-e", "SEARXNG_BASE_URL=http://localhost:8888",
              "--restart", "unless-stopped",
              "searxng/searxng",
            ], { shell: true, stdio: ["ignore", "pipe", "pipe"] })
            run.stdout?.on("data", (d) => log(d.toString().trim()))
            run.stderr?.on("data", (d) => log(d.toString().trim()))
            await new Promise<void>((resolve, reject) => {
              run.on("exit", (code) => code === 0 ? resolve() : reject(new Error("docker run failed (exit " + code + ")")))
            })
            log("SearXNG container started on port 8888.")

            // Wait a moment then re-check availability
            await new Promise((r) => setTimeout(r, 3000))
            checkSearXNG()
            log("SearXNG installed and running via Docker!")
            searxngInstallStatus = "complete"
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log("ERROR: " + msg)
            searxngInstallError = msg
            searxngInstallStatus = "error"
          }
        })()
      })

      // API: Multi-tier web search (Brave/Tavily > SearXNG > DDG > Wikipedia)
      server.middlewares.use('/local-api/web-search', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { query, count, provider, braveApiKey, tavilyApiKey } = JSON.parse(body)
            if (!query) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing query parameter' }))
              return
            }

            const maxResults = count || 5

            const fetchJSON = (url: string): Promise<any> => {
              return new Promise((resolve, reject) => {
                const proto = url.startsWith('https') ? https : http
                const httpReq = proto.get(url, { headers: { 'User-Agent': 'locally-uncensored/1.0', 'Accept': 'application/json' }, timeout: 8000 }, (response) => {
                  if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    fetchJSON(response.headers.location).then(resolve, reject)
                    return
                  }
                  if (response.statusCode !== 200) {
                    reject(new Error('HTTP ' + response.statusCode))
                    response.resume()
                    return
                  }
                  let data = ''
                  response.on('data', (chunk: Buffer) => { data += chunk.toString() })
                  response.on('end', () => {
                    try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
                  })
                })
                httpReq.on('error', reject)
                httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('timeout')) })
              })
            }

            // Tier 1: SearXNG (local instance)
            const trySearXNG = (): Promise<{ title: string; url: string; snippet: string }[]> => {
              if (!searxngAvailable) return Promise.reject(new Error('SearXNG not available'))
              const searxUrl = 'http://localhost:8888/search?q=' + encodeURIComponent(query) + '&format=json'
              return fetchJSON(searxUrl).then((data: any) => {
                if (!data.results || data.results.length === 0) throw new Error('SearXNG returned no results')
                console.log('[WebSearch] SearXNG returned ' + data.results.length + ' results')
                return data.results.slice(0, maxResults).map((r: any) => ({
                  title: r.title || '',
                  url: r.url || '',
                  snippet: r.content || '',
                }))
              })
            }

            // Tier 2: DuckDuckGo HTML search (POST, returns current results)
            const tryDDGHTML = (): Promise<{ title: string; url: string; snippet: string }[]> => {
              return new Promise((resolve, reject) => {
                const postData = 'q=' + encodeURIComponent(query)
                const options = {
                  hostname: 'html.duckduckgo.com',
                  port: 443,
                  path: '/html/',
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html',
                    'Accept-Language': 'en-US,en;q=0.9',
                  },
                  timeout: 10000,
                }
                const httpReq = https.request(options, (response) => {
                  if (response.statusCode !== 200) {
                    response.resume()
                    reject(new Error('DDG HTML returned HTTP ' + response.statusCode))
                    return
                  }
                  let html = ''
                  response.on('data', (chunk: Buffer) => { html += chunk.toString() })
                  response.on('end', () => {
                    try {
                      const results: { title: string; url: string; snippet: string }[] = []
                      // Parse result links: <a class="result__a" href="...">title</a>
                      const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
                      // Parse snippets: <a class="result__snippet" ...>snippet</a>
                      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

                      const links: { title: string; url: string }[] = []
                      let linkMatch
                      while ((linkMatch = linkRegex.exec(html)) !== null) {
                        let url = linkMatch[1]
                        // DDG wraps URLs in redirect: //duckduckgo.com/l/?uddg=ENCODED_URL
                        if (url.includes('uddg=')) {
                          const uddg = url.split('uddg=')[1]?.split('&')[0]
                          if (uddg) url = decodeURIComponent(uddg)
                        }
                        const title = linkMatch[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
                        if (title && url && url.startsWith('http')) {
                          links.push({ title, url })
                        }
                      }

                      const snippets: string[] = []
                      let snippetMatch
                      while ((snippetMatch = snippetRegex.exec(html)) !== null) {
                        snippets.push(snippetMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim())
                      }

                      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
                        results.push({
                          title: links[i].title,
                          url: links[i].url,
                          snippet: snippets[i] || '',
                        })
                      }

                      if (results.length === 0) throw new Error('DDG HTML returned no parseable results')
                      console.log('[WebSearch] DDG HTML returned ' + results.length + ' results')
                      resolve(results)
                    } catch (e) {
                      reject(e)
                    }
                  })
                })
                httpReq.on('error', reject)
                httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('DDG HTML timeout')) })
                httpReq.write(postData)
                httpReq.end()
              })
            }

            // Tier: Brave Search API (needs API key)
            const tryBrave = (): Promise<{ title: string; url: string; snippet: string }[]> => {
              if (!braveApiKey) return Promise.reject(new Error('No Brave API key'))
              const braveUrl = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + maxResults
              return new Promise((resolve, reject) => {
                const httpReq = https.get(braveUrl, {
                  headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveApiKey },
                  timeout: 8000,
                }, (response) => {
                  if (response.statusCode !== 200) { response.resume(); reject(new Error('Brave HTTP ' + response.statusCode)); return }
                  let data = ''
                  response.on('data', (chunk: Buffer) => { data += chunk.toString() })
                  response.on('end', () => {
                    try {
                      const parsed = JSON.parse(data)
                      const results = (parsed.web?.results || []).slice(0, maxResults).map((r: any) => ({
                        title: r.title || '', url: r.url || '', snippet: r.description || '',
                      }))
                      if (results.length === 0) throw new Error('Brave returned no results')
                      console.log('[WebSearch] Brave returned ' + results.length + ' results')
                      resolve(results)
                    } catch (e) { reject(e) }
                  })
                })
                httpReq.on('error', reject)
                httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Brave timeout')) })
              })
            }

            // Tier: Tavily Search API (needs API key, optimized for AI agents)
            const tryTavily = (): Promise<{ title: string; url: string; snippet: string }[]> => {
              if (!tavilyApiKey) return Promise.reject(new Error('No Tavily API key'))
              return new Promise((resolve, reject) => {
                const postData = JSON.stringify({ api_key: tavilyApiKey, query, max_results: maxResults, search_depth: 'basic' })
                const httpReq = https.request({
                  hostname: 'api.tavily.com', path: '/search', method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                  timeout: 10000,
                }, (response) => {
                  if (response.statusCode !== 200) { response.resume(); reject(new Error('Tavily HTTP ' + response.statusCode)); return }
                  let data = ''
                  response.on('data', (chunk: Buffer) => { data += chunk.toString() })
                  response.on('end', () => {
                    try {
                      const parsed = JSON.parse(data)
                      const results = (parsed.results || []).slice(0, maxResults).map((r: any) => ({
                        title: r.title || '', url: r.url || '', snippet: r.content || '',
                      }))
                      if (results.length === 0) throw new Error('Tavily returned no results')
                      console.log('[WebSearch] Tavily returned ' + results.length + ' results')
                      resolve(results)
                    } catch (e) { reject(e) }
                  })
                })
                httpReq.on('error', reject)
                httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Tavily timeout')) })
                httpReq.write(postData)
                httpReq.end()
              })
            }

            // Tier 3: Wikipedia API (always works)
            const tryWikipedia = (): Promise<{ title: string; url: string; snippet: string }[]> => {
              const wikiUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&srlimit=' + maxResults + '&utf8=1'
              return fetchJSON(wikiUrl).then((data: any) => {
                if (!data.query || !data.query.search || data.query.search.length === 0) {
                  throw new Error('Wikipedia returned no results')
                }
                console.log('[WebSearch] Wikipedia returned ' + data.query.search.length + ' results')
                return data.query.search.slice(0, maxResults).map((r: any) => ({
                  title: r.title || '',
                  url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(r.title.replace(/ /g, '_')),
                  snippet: (r.snippet || '').replace(/<[^>]*>/g, ''),
                }))
              })
            }

            // Execute tiers based on provider setting
            const searchChain = (): Promise<{ title: string; url: string; snippet: string }[]> => {
              if (provider === 'brave') return tryBrave().catch(() => trySearXNG()).catch(() => tryDDGHTML()).catch(() => tryWikipedia())
              if (provider === 'tavily') return tryTavily().catch(() => trySearXNG()).catch(() => tryDDGHTML()).catch(() => tryWikipedia())
              // 'auto': SearXNG > Brave (if key) > Tavily (if key) > DDG > Wikipedia
              return trySearXNG()
                .catch(() => braveApiKey ? tryBrave() : Promise.reject(new Error('no brave key')))
                .catch(() => tavilyApiKey ? tryTavily() : Promise.reject(new Error('no tavily key')))
                .catch(() => tryDDGHTML())
                .catch(() => tryWikipedia())
            }
            searchChain()
              .then((results) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ results }))
              })
              .catch((err) => {
                console.error('[WebSearch] All tiers failed:', (err as Error).message)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ results: [], error: 'All search tiers failed: ' + (err as Error).message }))
              })
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // --- Persistent Whisper STT Server ---
      // Spawns whisper_server.py ONCE, keeps model loaded in memory.
      // Subsequent transcriptions are fast (~2s) instead of re-loading (~170s).

      let whisperProc: ChildProcess | null = null
      let whisperReady = false
      let whisperBackend: string | null = null
      let whisperBuffer = ''
      const whisperQueue: Array<{ resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

      function handleWhisperLine(line: string) {
        try {
          const data = JSON.parse(line)
          if (data.status === 'ready') {
            whisperReady = true
            whisperBackend = data.backend || 'faster-whisper'
            console.log(`[Whisper] Server ready (backend: ${whisperBackend})`)
            return
          }
          if (data.status === 'error' && !whisperReady) {
            console.error('[Whisper] Server failed to start:', data.error)
            return
          }
          // Route response to the oldest queued request
          const pending = whisperQueue.shift()
          if (pending) {
            clearTimeout(pending.timer)
            pending.resolve(data)
          }
        } catch { /* not JSON, ignore */ }
      }

      function sendWhisperCommand(cmd: object, timeoutMs = 30000): Promise<any> {
        return new Promise((resolve, reject) => {
          if (!whisperProc || !whisperReady) {
            reject(new Error('Whisper server not ready'))
            return
          }
          const timer = setTimeout(() => {
            const idx = whisperQueue.findIndex(q => q.timer === timer)
            if (idx >= 0) whisperQueue.splice(idx, 1)
            reject(new Error('Whisper request timed out'))
          }, timeoutMs)
          whisperQueue.push({ resolve, reject, timer })
          whisperProc.stdin?.write(JSON.stringify(cmd) + '\n')
        })
      }

      // Start whisper server process
      const whisperScript = resolve(__dirname, 'public', 'whisper_server.py')
      if (existsSync(whisperScript)) {
        try {
          execSync(`"${pythonBin}" -c "import faster_whisper"`, { encoding: 'utf8', timeout: 15000 })
          console.log('[Whisper] faster-whisper found, starting persistent server...')
          whisperProc = spawn(pythonBin, [whisperScript], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
          whisperProc.stdout?.on('data', (d: Buffer) => {
            whisperBuffer += d.toString()
            const lines = whisperBuffer.split('\n')
            whisperBuffer = lines.pop() || ''
            for (const line of lines) {
              if (line.trim()) handleWhisperLine(line.trim())
            }
          })
          whisperProc.stderr?.on('data', (d: Buffer) => {
            console.log(`[Whisper] ${d.toString().trim()}`)
          })
          whisperProc.on('exit', (code) => {
            console.log(`[Whisper] Server exited (code ${code})`)
            whisperProc = null
            whisperReady = false
            // Reject all pending requests
            for (const q of whisperQueue.splice(0)) {
              clearTimeout(q.timer)
              q.reject(new Error('Whisper server exited'))
            }
          })
          whisperProc.on('error', (err) => {
            console.error('[Whisper] Server spawn error:', err.message)
          })

          // Clean up on server close
          const killWhisper = () => {
            if (whisperProc && !whisperProc.killed) {
              try { whisperProc.stdin?.write('{"action":"quit"}\n') } catch {}
              setTimeout(() => {
                try { whisperProc?.kill('SIGKILL') } catch {}
              }, 2000)
            }
          }
          server.httpServer?.on('close', killWhisper)
          process.on('exit', killWhisper)
        } catch {
          console.log('[Whisper] faster-whisper not installed — STT disabled')
        }
      }

      // API: Check if Whisper is available
      server.middlewares.use('/local-api/transcribe-status', (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (whisperProc) {
          res.end(JSON.stringify({
            available: true,
            backend: whisperBackend || 'faster-whisper',
            loading: !whisperReady,
          }))
        } else {
          res.end(JSON.stringify({ available: false, backend: null, error: 'Install faster-whisper: pip install faster-whisper' }))
        }
      })

      // API: Transcribe audio via persistent Whisper server
      server.middlewares.use('/local-api/transcribe', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', async () => {
          try {
            const audioBuffer = Buffer.concat(chunks)
            if (audioBuffer.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Empty audio data', transcript: '' }))
              return
            }

            if (!whisperProc || !whisperReady) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                error: whisperProc ? 'Whisper model is still loading, please wait...' : 'Whisper not available',
                transcript: '',
              }))
              return
            }

            // Determine file extension from content-type
            const contentType = req.headers['content-type'] || 'audio/webm'
            let ext = '.webm'
            if (contentType.includes('wav')) ext = '.wav'
            else if (contentType.includes('mp3') || contentType.includes('mpeg')) ext = '.mp3'
            else if (contentType.includes('ogg')) ext = '.ogg'
            else if (contentType.includes('mp4') || contentType.includes('m4a')) ext = '.m4a'

            const tmpFile = join(os.tmpdir(), `whisper-${Date.now()}${ext}`)
            const fs = require('fs')
            fs.writeFileSync(tmpFile, audioBuffer)

            console.log(`[Whisper] Transcribing: ${tmpFile} (${(audioBuffer.length / 1024).toFixed(1)} KB)`)
            const result = await sendWhisperCommand(
              { action: 'transcribe', path: tmpFile.replace(/\\/g, '/') },
              60000,
            )

            // Clean up temp file
            try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }

            if (result.error) {
              console.error('[Whisper] Transcription error:', result.error)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: result.error, transcript: '' }))
              return
            }

            console.log(`[Whisper] Transcribed: "${result.transcript?.substring(0, 80)}..." (lang: ${result.language})`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ transcript: result.transcript || '', language: result.language || 'en' }))
          } catch (err) {
            console.error('[Whisper] Request error:', (err as Error).message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err), transcript: '' }))
          }
        })
      })

    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), comfyLauncher()],
  server: {
    port: 5173,
    cors: true,
    allowedHosts: true,
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
      '/civitai-api': {
        target: 'https://civitai.com/api',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/civitai-api/, ''),
      },
    },
  },
})
