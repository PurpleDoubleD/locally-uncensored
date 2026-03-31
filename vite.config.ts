import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, createWriteStream, mkdirSync } from 'fs'
import { resolve, join, basename } from 'path'
import https from 'https'
import http from 'http'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

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
  // 3. Deep scan Desktop and Documents (one level of subdirectories)
  const scanDirs = [resolve(home, 'Desktop'), resolve(home, 'Documents')]
  for (const dir of scanDirs) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = join(dir, entry.name, 'ComfyUI')
          if (existsSync(resolve(candidate, 'main.py'))) return candidate
          // Also check if the folder itself IS ComfyUI
          if (existsSync(resolve(dir, entry.name, 'main.py'))) return join(dir, entry.name)
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  return null
}

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
    console.log(`[ComfyUI] Spawning python in: ${comfyPath}`)
    comfyProcess = spawn('python', ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
      cwd: comfyPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
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
      // Auto-start Ollama when dev server starts
      try {
        execSync('tasklist /FI "IMAGENAME eq ollama.exe" | find /I "ollama.exe"', { stdio: 'ignore' })
        console.log('[Ollama] Already running')
      } catch {
        console.log('[Ollama] Starting...')
        try {
          const ollamaProc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: true })
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
        return new Promise((resolve, reject) => {
          const filename = basename(destPath)
          activeDownloads.set(id, { progress: 0, total: 0, speed: 0, filename, status: 'connecting' })

          const doRequest = (requestUrl: string, redirectCount = 0) => {
            if (redirectCount > 5) { reject(new Error('Too many redirects')); return }
            const proto = requestUrl.startsWith('https') ? https : http
            proto.get(requestUrl, { headers: { 'User-Agent': 'LocallyUncensored/1.1' } }, (response) => {
              if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                doRequest(response.headers.location, redirectCount + 1)
                return
              }
              if (response.statusCode !== 200) {
                activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: `HTTP ${response.statusCode}` })
                reject(new Error(`HTTP ${response.statusCode}`))
                return
              }

              const total = parseInt(response.headers['content-length'] || '0', 10)
              let downloaded = 0
              let lastTime = Date.now()
              let lastBytes = 0

              const dir = resolve(destPath, '..')
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
                resolve()
              })
              file.on('error', (err) => {
                activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: err.message })
                reject(err)
              })
            }).on('error', (err) => {
              activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: err.message })
              reject(err)
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
            const { url, subfolder, filename } = JSON.parse(body)
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
            const destDir = join(comfyPath, 'models', subfolder)
            const destPath = join(destDir, filename)

            if (existsSync(destPath)) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'already_exists', id: filename }))
              return
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
          // Clean up completed downloads after 30s
          if (info.status === 'complete' || info.status === 'error') {
            setTimeout(() => activeDownloads.delete(id), 30000)
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(downloads))
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

            const proc = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', code], {
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

      // API: Web search via DuckDuckGo lite
      server.middlewares.use('/local-api/web-search', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          try {
            const { query, count } = JSON.parse(body)
            if (!query) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing query parameter' }))
              return
            }

            const maxResults = count || 5
            const searchUrl = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query)

            https.get(searchUrl, { headers: { 'User-Agent': 'LocallyUncensored/1.1' } }, (response) => {
              let html = ''
              response.on('data', (chunk: Buffer) => { html += chunk.toString() })
              response.on('end', () => {
                try {
                  const results: { title: string; url: string; snippet: string }[] = []

                  // Parse DuckDuckGo lite HTML results
                  const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
                  const snippetRegex = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi

                  const links: { url: string; title: string }[] = []
                  let linkMatch
                  while ((linkMatch = linkRegex.exec(html)) !== null) {
                    const linkUrl = linkMatch[1].replace(/&amp;/g, '&')
                    const title = linkMatch[2].replace(/<[^>]*>/g, '').trim()
                    if (linkUrl && title) links.push({ url: linkUrl, title })
                  }

                  const snippets: string[] = []
                  let snippetMatch
                  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
                    snippets.push(snippetMatch[1].replace(/<[^>]*>/g, '').trim())
                  }

                  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
                    results.push({
                      title: links[i].title,
                      url: links[i].url,
                      snippet: snippets[i] || '',
                    })
                  }

                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ results }))
                } catch (parseErr) {
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ results: [], error: 'Failed to parse results' }))
                }
              })
            }).on('error', (err) => {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ results: [], error: err.message }))
            })
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
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
