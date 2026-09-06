import { spawn, execSync, execFileSync, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import type { RouteMount } from './routes'
import { pythonBin } from './python'
import { ENV_FILE } from './paths'
import { requirePost, withJsonBody, failRequest } from './http'
import { bodyString } from '../src/dev/http-body'
import { customNodeDir } from '../src/dev/model-paths'
import { errorText } from '../src/types/json-guards'

export function findComfyUI(): string | null {
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

export function isComfyRunning(): Promise<boolean> {
  return fetch('http://localhost:8188/system_stats')
    .then(r => r.ok)
    .catch(() => false)
}

/**
 * Der ComfyUI-Kindprozess und alles, was ihn anfasst.
 *
 * Ein Modul, weil hier genau EIN veränderlicher Zustand liegt — der laufende
 * Prozess und sein Logpuffer — und weil jede Zeile, die ihn anfasst, in
 * derselben Datei stehen muss, damit niemand ihn von aussen umgeht.
 */
export function createComfyLauncher() {
let comfyProcess: ChildProcess | null = null
let comfyLogs: string[] = []

// Mirror the Rust launcher (process.rs): prefer a venv python so ComfyUI runs
// inside the env pip installed torch into. Checks both the classic `venv` and
// the modern `.venv` (issue #51, adhney). Dev-mode only.
const getComfyPython = (comfyPath: string): string => {
  const isWin = process.platform === 'win32'
  for (const v of ['venv', '.venv']) {
    const vp = isWin
      ? join(comfyPath, v, 'Scripts', 'python.exe')
      : join(comfyPath, v, 'bin', 'python')
    if (existsSync(vp)) {
      console.log(`[ComfyUI] Using venv python: ${vp}`)
      return vp
    }
  }
  return pythonBin
}

const startComfy = (comfyPath: string): { status: string; path: string } => {
  if (comfyProcess && !comfyProcess.killed) {
    return { status: 'already_running', path: comfyPath }
  }

  comfyLogs = []
  const executable = getComfyPython(comfyPath)
  console.log(`[ComfyUI] Spawning ${executable} in: ${comfyPath}`)
  comfyProcess = spawn(executable, ['main.py', '--listen', '127.0.0.1', '--port', '8188', '--enable-cors-header', '*'], {
    cwd: comfyPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    // Mirror the Rust launcher (process.rs): force UTF-8 I/O so ComfyUI's
    // Unicode progress glyphs don't crash on a non-UTF-8 Windows codepage
    // (plum133 'charmap' codec UnicodeEncodeError, Discord 2026-06-07).
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
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
    startComfy,
    stopComfy,
    /** Läuft unser eigener Kindprozess noch? (comfyui-status) */
    processAlive: () => comfyProcess !== null && !comfyProcess.killed,
    /** Die letzten Ausgabezeilen, wie comfyui-status sie immer meldete. */
    recentLogs: () => comfyLogs.slice(-20),
  }
}

export type ComfyLauncher = ReturnType<typeof createComfyLauncher>

/** Startet ComfyUI eine Sekunde nach dem Dev-Server, wenn es nicht schon läuft. */
export function autostartComfy(comfy: ComfyLauncher): void {
  // Auto-start ComfyUI when dev server starts
  setTimeout(async () => {
    try {
      const running = await isComfyRunning()
      if (!running) {
        const comfyPath = findComfyUI()
        if (comfyPath) {
          console.log(`[ComfyUI] Auto-starting from: ${comfyPath}`)
          const result = comfy.startComfy(comfyPath)
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
}

/** Start und Stopp von Hand. */
export function registerComfyControlRoutes(routes: RouteMount, comfy: ComfyLauncher): void {
  // API: Manual start
  routes.use('/local-api/start-comfyui', async (_req, res) => {
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
      const result = comfy.startComfy(comfyPath)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'error', message: String(err) }))
    }
  })

  // API: Stop
  routes.use('/local-api/stop-comfyui', (_req, res) => {
    comfy.stopComfy()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'stopped' }))
  })
}

/** Installation, Pfadwahl und Status — alles, was eine ComfyUI erst herstellt. */
export function registerComfyInstallRoutes(routes: RouteMount, comfy: ComfyLauncher): void {
  // API: Install custom node (git clone into ComfyUI/custom_nodes/)
  routes.use('/local-api/install-custom-node', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const repoUrl = bodyString(body, 'repoUrl', 'repo_url') ?? ''
        const nodeName = bodyString(body, 'nodeName', 'node_name') ?? ''
        const comfyPath = findComfyUI()
        if (!comfyPath) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'ComfyUI not found. Install ComfyUI first.' }))
          return
        }
        const customNodesDir = join(comfyPath, 'custom_nodes')
        if (!existsSync(customNodesDir)) mkdirSync(customNodesDir, { recursive: true })
        // SICHERHEITSBEFUND: `nodeName` hing ungeprüft an `custom_nodes/`
        // (`'../../..'` klonte ausserhalb von ComfyUI), und `repoUrl` ging in
        // eine SHELL-Zeichenkette — `x"; rm -rf ~; echo "` war ein zweites
        // Kommando. Der Käfig steht jetzt in src/dev/model-paths.ts, und
        // execFileSync übergibt Argumente ohne Shell dazwischen.
        const targetDir = customNodeDir(comfyPath, nodeName, repoUrl)
        if (existsSync(targetDir)) {
          console.log(`[CustomNode] Already installed: ${nodeName}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'already_installed', path: targetDir }))
          return
        }
        console.log(`[CustomNode] Installing ${nodeName} from ${repoUrl}...`)
        try {
          execFileSync('git', ['clone', repoUrl, targetDir], { timeout: 120000 })
          // Try pip install if requirements.txt exists
          const reqFile = join(targetDir, 'requirements.txt')
          if (existsSync(reqFile)) {
            try {
              execFileSync('pip', ['install', '-r', reqFile], { cwd: targetDir, timeout: 300000 })
            } catch (pipErr) {
              console.warn(`[CustomNode] pip install failed for ${nodeName}:`, errorText(pipErr))
            }
          }
          console.log(`[CustomNode] Installed: ${nodeName}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'installed', path: targetDir }))
        } catch (gitErr) {
          const detail = errorText(gitErr)
          console.error(`[CustomNode] Git clone failed:`, detail)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Git clone failed: ${detail}` }))
        }
      } catch (err) {
        failRequest(res, err)
      }
    })
  })

  // API: Set ComfyUI path (writes to .env and starts ComfyUI)
  routes.use('/local-api/set-comfyui-path', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const newPath = bodyString(body, 'path') ?? ''
        // Ohne Pfad gibt es nichts zu prüfen; `join(undefined, …)` warf hier
        // vorher eine TypeError in den Catch und meldete sie als "error".
        const mainPy = newPath ? join(newPath, 'main.py') : ''
        if (!mainPy || !existsSync(mainPy)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', error: `main.py not found in "${newPath}". Make sure this is the ComfyUI root folder.` }))
          return
        }

        // Write to .env file
        const envPath = ENV_FILE
        let envContent = ''
        try { envContent = readFileSync(envPath, 'utf8') } catch { /* no .env yet */ }

        const currentMatch = envContent.match(/^COMFYUI_PATH=(.*)$/m)
        if (!currentMatch || currentMatch[1].trim() !== newPath) {
          if (envContent.includes('COMFYUI_PATH=')) {
            envContent = envContent.replace(/COMFYUI_PATH=.*/g, `COMFYUI_PATH=${newPath}`)
          } else {
            envContent += `${envContent.endsWith('\n') || envContent === '' ? '' : '\n'}COMFYUI_PATH=${newPath}\n`
          }
          writeFileSync(envPath, envContent, 'utf8')
        }

        // Update process.env
        process.env.COMFYUI_PATH = newPath
        console.log(`[ComfyUI] Path set to: ${newPath}`)

        // Auto-start ComfyUI
        const result = comfy.startComfy(newPath)
        console.log(`[ComfyUI] Start result: ${result.status}`)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', path: newPath }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'error', error: errorText(err) || String(err) }))
      }
    })
  })

  // API: Install ComfyUI from scratch
  const installLogs: string[] = []
  let installStatus: 'idle' | 'installing' | 'complete' | 'error' = 'idle'
  let installError = ''

  routes.use('/local-api/install-comfyui', (req, res) => {
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
        const envPath = ENV_FILE
        let envContent = ''
        try { envContent = readFileSync(envPath, 'utf8') } catch { /* no .env */ }
        const currentMatch = envContent.match(/^COMFYUI_PATH=(.*)$/m)
        if (!currentMatch || currentMatch[1].trim() !== installDir) {
          if (envContent.includes('COMFYUI_PATH=')) {
            envContent = envContent.replace(/COMFYUI_PATH=.*/g, `COMFYUI_PATH=${installDir}`)
          } else {
            envContent += `${envContent.endsWith('\n') || envContent === '' ? '' : '\n'}COMFYUI_PATH=${installDir}\n`
          }
          writeFileSync(envPath, envContent, 'utf8')
        }
        process.env.COMFYUI_PATH = installDir
        log(`Path saved to .env: ${installDir}`)

        // Step 5: Start ComfyUI
        log('Starting ComfyUI...')
        comfy.startComfy(installDir)
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
  routes.use('/local-api/comfyui-status', async (_req, res) => {
    let running = false
    try { running = await isComfyRunning() } catch { /* ignore */ }
    const comfyPath = findComfyUI()
    const processAlive = comfy.processAlive()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      running,
      starting: processAlive && !running,
      found: comfyPath !== null,
      path: comfyPath,
      logs: comfy.recentLogs(),
      processAlive,
    }))
  })
}
