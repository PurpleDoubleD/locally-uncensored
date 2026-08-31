import { defineConfig, parseAst, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, createWriteStream, mkdirSync, statSync, type Dirent } from 'fs'
import { resolve, join, basename, isAbsolute } from 'path'
import https from 'https'
import http from 'http'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import os from 'os'
import dns from 'node:dns'
import net from 'node:net'
import { devResolveWithinJail, effectiveByteCap, JailEscapeError } from './src/lib/dev-fs-jail'
import { postContentTypeAllowed, postContentTypeError } from './src/lib/local-api-guard'

// The port the dev server binds and the only port the /local-api origin check
// treats as canonical. Kept next to the guard it feeds so the two can't drift
// apart — an origin allowlist that names a port the server no longer listens
// on silently degrades to "loopback regex only".
const DEV_PORT = 5273

// ── Dev-server SSRF guard ───────────────────────────────────────
// The dev proxies that fetch a *user-supplied* ?url= (proxy-image,
// proxy-download) are an SSRF sink: a markdown image / download link could
// point the server at an internal address (169.254.169.254 metadata, LAN
// boxes, localhost services). The packaged desktop app routes these through
// the Rust proxy, which has the strong validate_public_url guard
// (src-tauri/src/commands/proxy.rs); this is the parity guard for the
// `npm run dev` / web build (konata's SSH-tunnel path). Best-effort against
// DNS-rebind — this is a dev server, not the production trust boundary.
function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
    const [a, b] = p
    if (a === 0) return true // 0.0.0.0/8 "this host"
    if (a === 10) return true // 10/8 private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local + 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
    if (a === 192 && b === 168) return true // 192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
    if (a >= 224) return true // multicast + reserved
    return false
  }
  if (v === 6) {
    const lc = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (lc === '::1' || lc === '::') return true // loopback / unspecified
    if (lc.startsWith('fe80')) return true // link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true // ULA fc00::/7
    if (lc.startsWith('64:ff9b:')) return true // NAT64 (embeds an IPv4 — block)
    // IPv4-mapped IPv6 in BOTH the dotted (::ffff:127.0.0.1) and the hex
    // (::ffff:7f00:1) forms — decode the embedded IPv4 and re-check it.
    const dotted = lc.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (dotted) return isBlockedIp(dotted[1])
    const hex = lc.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      return isBlockedIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
    }
    return false
  }
  return false // not an IP literal — caller resolves DNS and re-checks
}

async function assertPublicUrl(urlStr: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    throw new Error('invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme not allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('no host')
  if (host === 'localhost' || host.toLowerCase().endsWith('.localhost')) throw new Error('blocked host')
  // Reject all-digit decimal / 0x-hex integer hosts (inet_aton SSRF encodings).
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new Error('blocked numeric host')
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('blocked ip')
    return u
  }
  const addrs = await dns.promises.lookup(host, { all: true })
  if (!addrs.length) throw new Error('dns empty')
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error('blocked resolved ip')
  }
  return u
}

// Load .env file from project root
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '.env') })

// §1.6 — Strip console.log/info/debug from PRODUCTION builds, keep warn/error.
//
// Why a hand-rolled plugin instead of a minify option: Vite 8 here is
// rolldown-based and uses the oxc minifier (the build literally logs
// "Both esbuild and oxc options were set. oxc options will be used and
// esbuild options will be ignored" — so the old `esbuild: { drop, pure }`
// block was DEAD and console.* shipped). rolldown@1.0.2's oxc
// `CompressOptions` exposes only an all-or-nothing `dropConsole: boolean`
// (no Terser-style `pure_funcs`), which would also strip warn/error — and
// rolldown-vite doesn't reliably plumb it through anyway (vitejs/rolldown-vite#302).
// So we AST-remove the three noisy methods ourselves and leave warn/error
// intact so genuine problems still surface in a power user's devtools.
//
// Uses Vite's built-in `parseAst` (oxc parser, ESTree output with byte
// offsets) — no new dependency. Production sourcemaps are off here
// (`build.sourcemap` unset → default false), so returning transformed code
// without a map is safe; the guard below also bails when a map is requested.
function stripConsolePlugin(): Plugin {
  const TARGETS = new Set(['log', 'info', 'debug'])
  const STRIPPABLE = /\.[cm]?[jt]sx?$/

  // True iff `node` is a `console.log(...)` / `.info` / `.debug` CallExpression.
  // Matches the bare `console.<m>(…)` member call only — `foo.console.log`,
  // `myLogger.log`, and re-assigned `const x = console.log` are left alone.
  const isStrippableConsoleCall = (node: any): boolean => {
    if (!node || node.type !== 'CallExpression') return false
    const callee = node.callee
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false
    const obj = callee.object
    const prop = callee.property
    return (
      obj?.type === 'Identifier' &&
      obj.name === 'console' &&
      prop?.type === 'Identifier' &&
      TARGETS.has(prop.name)
    )
  }

  return {
    name: 'lu-strip-console',
    apply: 'build',
    transform(code, id) {
      if (id.includes('\0')) return null // virtual module
      if (id.includes('node_modules')) return null
      const clean = id.split('?')[0]
      // The structured logger (src/lib/logger.ts) is the ONE sanctioned console
      // sink: in production it serialises every event to a single-line JSON
      // object on stdout via `console.log`. That call is a brace-less
      // `else console.log(line)` which this plugin would neutralise to `void 0`,
      // silencing every log.info/log.debug in prod and defeating the logger's
      // whole purpose. Leave the logger module untouched, like node_modules.
      if (/[\\/]lib[\\/]logger\.[cm]?[jt]sx?$/.test(clean)) return null
      if (!STRIPPABLE.test(clean)) return null
      if (!code.includes('console.')) return null

      let ast: any
      try {
        ast = parseAst(code, { sourceType: 'module' })
      } catch {
        return null // let the real parse step report syntax errors
      }

      // Containers where an ExpressionStatement can simply be deleted with
      // no syntactic fallout (its siblings or the empty block remain valid).
      const BLOCK_LIKE = new Set(['BlockStatement', 'Program', 'StaticBlock'])

      // Collect [start,end) byte ranges of every strippable call.
      //   • Whole-statement call inside a block  → delete the statement.
      //   • Whole-statement call that is the *single* (brace-less) body of an
      //     if/else/for/while/do/with/label arm → replace the CALL with
      //     `void 0` so the arm keeps a statement (`else void 0;`). Deleting
      //     it would orphan the `else`/`for(...)` and break parsing — this
      //     was the logger.ts `if (…) console.error(x)\nelse console.log(y)`
      //     case that the naive version corrupted.
      //   • Call used as a sub-expression (`a && console.log(b)`, a ternary
      //     arm, an arg) → replace the CALL with `void 0`.
      const removals: Array<{ start: number; end: number; replacement: string }> = []

      const visit = (node: any, parent: any, grandparent: any, parentKey: string | null): void => {
        if (!node || typeof node.type !== 'string') return
        if (isStrippableConsoleCall(node)) {
          const stmt = parent && parent.type === 'ExpressionStatement' && parent.expression === node
            ? parent
            : null
          if (stmt && grandparent && BLOCK_LIKE.has(grandparent.type)) {
            // Safe to drop the whole statement (incl. its trailing `;`).
            removals.push({ start: stmt.start, end: stmt.end, replacement: '' })
          } else if (stmt && grandparent && grandparent.type === 'SwitchCase' && parentKey === 'consequent') {
            removals.push({ start: stmt.start, end: stmt.end, replacement: '' })
          } else {
            // Brace-less control-flow arm OR a sub-expression: neutralise the
            // call but keep a valid expression in its place.
            removals.push({ start: node.start, end: node.end, replacement: 'void 0' })
          }
          return // don't descend into the args of a call we're deleting
        }
        for (const key in node) {
          if (key === 'start' || key === 'end' || key === 'parent') continue
          const child = (node as any)[key]
          if (Array.isArray(child)) {
            for (const c of child) {
              if (c && typeof c.type === 'string') visit(c, node, parent, key)
            }
          } else if (child && typeof child.type === 'string') {
            visit(child, node, parent, key)
          }
        }
      }
      visit(ast, null, null, null)

      if (removals.length === 0) return null

      // Apply back-to-front so earlier offsets stay valid.
      removals.sort((a, b) => b.start - a.start)
      let out = code
      for (const r of removals) {
        out = out.slice(0, r.start) + r.replacement + out.slice(r.end)
      }
      // Sourcemaps are off for prod here; null map signals "I rewrote the
      // text, don't trust a passthrough map" without fabricating one.
      return { code: out, map: null }
    },
  }
}

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
    name: 'comfy-launcher',
    configureServer(server) {
      // --- Security Middleware ---
      server.middlewares.use('/local-api', (req, res, next) => {
        // Exclude GET proxy-image/download from strict header checks (used in <img> tags and simple fetches)
        if (req.method === 'GET' && (req.url?.startsWith('/proxy-image') || req.url?.startsWith('/proxy-download'))) {
          return next();
        }

        // 1. Strict Content-Type enforcement for POST requests. The rule is
        // application/json everywhere except /transcribe, whose body IS the
        // raw recorded audio and was 415'd here before the whisper handler
        // ever saw it (GitHub #115, graysoncooper). The carve-out swaps the
        // JSON requirement for an audio one, it does not drop the check.
        if (req.method === 'POST') {
           const contentType = String(req.headers['content-type'] || '');
           if (!postContentTypeAllowed(req.url, contentType)) {
               res.writeHead(415, { 'Content-Type': 'text/plain' });
               res.end(postContentTypeError(req.url));
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
            // The allowlist is built from constants only. It used to append
            // `http(s)://${req.headers.host}` so a request always matched its
            // own host — but the Host header is attacker-chosen under DNS
            // rebinding: a page on evil.com whose DNS flips to 127.0.0.1 sends
            // Origin *and* Host of evil.com, the two agree, and the check waved
            // the request through to /shell-execute and /execute-code with no
            // authentication at all. A value the caller supplies can never be
            // the thing that authorises the caller.
            // Loopback on any port stays allowed: Vite binds 5274+ when 5273 is
            // busy and the page it serves then legitimately carries that origin
            // (issue #51, adhney). That stays safe where the host header did
            // not, because rebinding hands the attacker a *name* — the browser
            // only stamps a literal 127.0.0.1/localhost origin on a page it
            // really loaded from loopback, and `evil.localhost` (which Vite's
            // own host check tolerates) does not match this pattern.
            const allowedOrigins = [
                'tauri://localhost', 'http://tauri.localhost',
                `http://localhost:${DEV_PORT}`, `http://127.0.0.1:${DEV_PORT}`,
            ];
            const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
            if (!allowedOrigins.includes(origin) && !isLoopback) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden: Invalid Origin (CSRF Protection)');
                return;
            }
        }

        next();
      });

      // Auto-start Ollama when dev server starts (best-effort, NEVER fatal:
      // a from-source dev run may not have Ollama installed at all — #63
      // cpack299, Ubuntu 24).
      const ollamaAlreadyRunning = (() => {
        try {
          if (process.platform === 'win32') {
            execSync('tasklist /FI "IMAGENAME eq ollama.exe" | find /I "ollama.exe"', { stdio: 'ignore' })
          } else {
            // tasklist is Windows-only; on macOS/Linux use pgrep so a Linux
            // dev box doesn't fall through and needlessly re-spawn Ollama.
            execSync('pgrep -x ollama', { stdio: 'ignore' })
          }
          return true
        } catch {
          return false
        }
      })()
      if (ollamaAlreadyRunning) {
        console.log('[Ollama] Already running')
      } else {
        console.log('[Ollama] Launching in background…')
        try {
          const ollamaProc = spawn('ollama', ['serve'], {
            detached: true,
            stdio: 'ignore',
            shell: false,
            windowsHide: true,
          })
          // CRITICAL: spawn() reports a missing binary ASYNCHRONOUSLY via an
          // 'error' event, not a throw — so the try/catch around it does NOT
          // catch ENOENT. Without this handler, an absent Ollama crashes the
          // whole `npm run dev` with "Error: spawn ollama ENOENT" (#63). Handle
          // it so a missing Ollama is a friendly hint, not a fatal crash.
          ollamaProc.on('error', (err: NodeJS.ErrnoException) => {
            if (err && err.code === 'ENOENT') {
              console.warn('[Ollama] Not started — Ollama is not installed or not on PATH. Install it from https://ollama.com/download (release builds bundle it). The dev server keeps running.')
            } else {
              console.warn('[Ollama] Failed to start:', err?.message || err)
            }
          })
          ollamaProc.unref()
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

      // API: ComfyUI POST proxy (workaround for Vite 8 blocking POST via proxy).
      // David 2026-06-16 — konata's "Failed to upload image: HTTP 400" (web build
      // via SSH-tunneled `npm run dev`) reproduced HERE: this proxy used to buffer
      // the body as a STRING (`body += chunk` corrupts binary image bytes) and
      // HARDCODE Content-Type: application/json (strips the multipart/form-data
      // boundary). JSON POSTs (submit/history) survived; the I2V image upload
      // (/upload/image, multipart) reached ComfyUI as garbage → 400. Fix: buffer
      // the raw bytes intact and forward the REAL Content-Type (with its boundary)
      // + Content-Length, so multipart uploads pass through unchanged.
      server.middlewares.use('/comfyui', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const targetPath = (req.url || '').replace(/^\/comfyui/, '') || '/'
        const inChunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => { inChunks.push(chunk) })
        req.on('end', () => {
          const body = Buffer.concat(inChunks)
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: 8188,
            path: targetPath,
            method: 'POST',
            headers: {
              'Content-Type': (req.headers['content-type'] as string) || 'application/json',
              'Content-Length': body.length,
            },
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
        const deny = () => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'blocked by SSRF guard' })) }
        // Validate the original URL, then re-validate the redirect target (a
        // public host can 30x to an internal one).
        assertPublicUrl(imgUrl).then((u) => {
          const proto = u.protocol === 'https:' ? https : http
          proto.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (upstream) => {
            if (upstream.statusCode && upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
              upstream.resume() // drain the redirect body
              // Resolve relative redirects against the current hop (imgUrl was
              // already validated) before re-validating + following.
              let loc: string
              try { loc = new URL(upstream.headers.location, imgUrl).toString() } catch { deny(); return }
              assertPublicUrl(loc).then((lu) => {
                const lproto = lu.protocol === 'https:' ? https : http
                lproto.get(loc, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (redir) => {
                  res.writeHead(redir.statusCode || 200, {
                    'Content-Type': redir.headers['content-type'] || 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400',
                  })
                  redir.pipe(res)
                }).on('error', () => { res.writeHead(502); res.end() })
              }).catch(deny)
              return
            }
            res.writeHead(upstream.statusCode || 200, {
              'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
            })
            upstream.pipe(res)
          }).on('error', () => { res.writeHead(502); res.end() })
        }).catch(deny)
      })

      // API: Proxy download (follows redirects server-side, avoids CORS)
      server.middlewares.use('/local-api/proxy-download', (req, res) => {
        const url = new URL(req.url || '', 'http://localhost').searchParams.get('url')
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing url parameter' }))
          return
        }

        const fetchUrl = (targetUrl: string, redirectCount = 0) => {
          if (redirectCount > 5) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Too many redirects' }))
            return
          }
          // Validate every hop (initial URL + each redirect target) so a public
          // host can't 30x the server into an internal address.
          assertPublicUrl(targetUrl).then((u) => {
            const protocol = u.protocol === 'https:' ? https : http
            protocol.get(targetUrl, { headers: { 'User-Agent': 'LocallyUncensored/1.0' } }, (upstream) => {
              if (upstream.statusCode && upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
                upstream.resume()
                // Resolve relative redirects against the current hop (targetUrl
                // was already validated) before the next hop re-validates.
                let nextUrl: string
                try { nextUrl = new URL(upstream.headers.location, targetUrl).toString() } catch { res.writeHead(502); res.end(); return }
                fetchUrl(nextUrl, redirectCount + 1)
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
          }).catch(() => {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'blocked by SSRF guard' }))
          })
        }
        fetchUrl(url)
      })

      // ─── Remote Access stubs (dev mode) ───────────────────────────
      // Reported by @phantomderp on v2.4.2: clicking LAN/Internet from
      // `npm run dev` returned an HTML 404 page that the frontend then
      // tried to JSON.parse, producing a cryptic
      // "SyntaxError: unexpected character at line 1 column 1" stacktrace.
      //
      // Remote Access is fundamentally a Tauri-only feature: a Rust axum
      // server, JWT auth, Cloudflare tunnel binary management,
      // mobile-UI static serve. None of that exists in the vite dev
      // process. Mirroring it here would mean reimplementing ~3700 lines
      // of Rust in Node middleware plus a forever maintenance burden.
      //
      // Instead: respond with HTTP 501 + a structured JSON body so the
      // frontend can surface a clear actionable error. The Sidebar +
      // remoteStore already short-circuit before fetch() in dev mode
      // (REMOTE_DEV_MODE_ERROR); these stubs are the backstop for any
      // future caller that bypasses those guards.
      const REMOTE_DEV_MODE_BODY = JSON.stringify({
        error: "Remote Access requires the installed desktop app. Use `npm run tauri:dev` for full Remote in development — the plain vite dev server can't host the Rust backend Remote needs.",
        devModeOnly: true,
      })
      const remoteStubPaths = [
        '/local-api/start-remote-server',
        '/local-api/stop-remote-server',
        '/local-api/restart-remote-server',
        '/local-api/remote-server-status',
        '/local-api/regenerate-remote-token',
        '/local-api/remote-qr-code',
        '/local-api/remote-connected-devices',
        '/local-api/disconnect-remote-device',
        '/local-api/set-remote-permissions',
        '/local-api/start-tunnel',
        '/local-api/stop-tunnel',
        '/local-api/tunnel-status',
      ]
      for (const path of remoteStubPaths) {
        server.middlewares.use(path, (_req, res) => {
          res.writeHead(501, { 'Content-Type': 'application/json' })
          res.end(REMOTE_DEV_MODE_BODY)
        })
      }

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

            // Resume support (issue #51, adhney): if a partial file exists, ask
            // the server for the remaining bytes via Range instead of restarting
            // from 0. Packaged mode (download.rs) already does this; this is the
            // dev-server parity.
            let existingSize = 0
            const headers: Record<string, string> = { 'User-Agent': 'LocallyUncensored/1.1' }
            if (existsSync(destPath)) {
              try {
                existingSize = statSync(destPath).size
                if (existingSize > 0) headers['Range'] = `bytes=${existingSize}-`
              } catch { /* ignore — fall back to a full download */ }
            }

            const proto = requestUrl.startsWith('https') ? https : http
            proto.get(requestUrl, { headers }, (response) => {
              if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                doRequest(response.headers.location, redirectCount + 1)
                return
              }
              const isPartial = response.statusCode === 206
              if (response.statusCode !== 200 && !isPartial) {
                activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: `HTTP ${response.statusCode}` })
                promiseReject(new Error(`HTTP ${response.statusCode}`))
                return
              }

              const contentLength = parseInt(response.headers['content-length'] || '0', 10)
              const total = isPartial ? contentLength + existingSize : contentLength
              let downloaded = isPartial ? existingSize : 0
              let lastTime = Date.now()
              let lastBytes = downloaded

              const dir = dirname(destPath)
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
              const file = createWriteStream(destPath, { flags: isPartial ? 'a' : 'w' })

              activeDownloads.set(id, { progress: downloaded, total, speed: 0, filename, status: 'downloading' })

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
            // Don't restart an in-flight download from 0 if the UI re-fires the
            // start (issue #51, adhney).
            const active = activeDownloads.get(id)
            if (active && (active.status === 'downloading' || active.status === 'connecting')) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'started', id }))
              return
            }
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
            const home = os.homedir()
            // Which backend was asked about used to be read and then thrown
            // away: every provider got LM Studio's directory back, including
            // Ollama and the built-in engine. Mirrors the dispatch in the Rust
            // command (src-tauri/src/commands/download.rs detect_model_path)
            // for the backends with a conventional managed dir; everything
            // else falls through to the LU fallback dir below, as there.
            const asked = String(provider ?? '').toLowerCase()
            const candidates =
              asked === 'ollama'
                ? [join(home, '.ollama', 'models')]
                : asked === 'lm studio' || asked === 'lmstudio'
                  ? [
                      join(home, '.lmstudio', 'models'),
                      join(home, '.cache', 'lm-studio', 'models'),
                      join(home, 'AppData', 'Local', 'LM Studio', 'models'),
                      join(home, '.local', 'share', 'lm-studio', 'models'),
                    ]
                  : asked === 'jan'
                    ? [join(home, '.jan', 'models'), join(home, 'jan', 'models')]
                    : asked === 'gpt4all'
                      ? [join(home, '.cache', 'gpt4all')]
                      : []
            const found = candidates.find((p) => existsSync(p))
            if (found) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(found))
            } else {
              // Fallback: create LU models directory (same as Rust backend)
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
            // Prefer the ComfyUI path the app actually persisted (matches the
            // Rust backend); only then fall back to common defaults. Without
            // this the dev stub guessed wrong for non-default installs and
            // reported every curated model "incomplete" → "no image model"
            // (konata-session 2026-06-07).
            let comfyPath = ''
            try {
              const cfgPath = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'locally-uncensored', 'config.json')
              if (existsSync(cfgPath)) {
                const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'))
                if (cfg.comfyui_path && existsSync(cfg.comfyui_path)) comfyPath = cfg.comfyui_path
              }
            } catch { /* ignore — fall through to candidates */ }
            if (!comfyPath) {
              const candidates = [
                join(home, 'ComfyUI'),
                join(home, 'Desktop', 'ComfyUI'),
                'C:\\ComfyUI',
              ]
              comfyPath = candidates.find(p => existsSync(p)) || join(home, 'ComfyUI')
            }
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
            const active = activeDownloads.get(id)
            if (active && (active.status === 'downloading' || active.status === 'connecting')) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'started', id }))
              return
            }
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
                // The typed execSync is already imported at the top of this
                // file; the inline require shadowed it with an untyped one.
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

      // API: FS read bytes — base64 payload of ONE file for the Explorer image
      // preview (2.6.6 C3). Parity port of the `fs_read_bytes` Tauri command:
      // SAME jail (workspace root, then containment — see lib/dev-fs-jail) and
      // the SAME 16 MiB ceiling, because a preview is a picture on a 280px
      // panel, not a payload. Deliberately stricter than the fs-read
      // middleware above, which predates the jail and stays as it is.
      server.middlewares.use('/local-api/fs-read-bytes', (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        let body = ''
        req.on('data', (c: any) => { body += c })
        req.on('end', () => {
          const fail = (status: number, error: string) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error }))
          }
          try {
            const { path: filePath, chatId, workingDirectory, maxBytes } = JSON.parse(body)
            if (typeof filePath !== 'string' || !filePath) {
              fail(400, 'Missing path')
              return
            }
            const resolved = devResolveWithinJail({
              path: filePath,
              homeDir: os.homedir(),
              chatId,
              workingDirectory,
            })
            const fs = require('fs')
            if (!existsSync(resolved) || !statSync(resolved).isFile()) {
              fail(400, `File not found: ${resolved}`)
              return
            }
            const cap = effectiveByteCap(maxBytes)
            const size = statSync(resolved).size
            if (size > cap) {
              fail(400, `File is too large to preview: ${size} bytes (limit ${cap})`)
              return
            }
            const buf = fs.readFileSync(resolved)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ base64: buf.toString('base64'), bytes: buf.length }))
          } catch (err) {
            fail(err instanceof JailEscapeError ? 403 : 400, String(err instanceof Error ? err.message : err))
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
            const resolved = isAbsolute(dirPath) ? dirPath : join(os.homedir(), 'agent-workspace', dirPath)
            const entries: Array<{ name: string; path: string; size: number; isDir: boolean; modified: number }> = []
            // `recursive` arrived from the caller (file_list passes the model's
            // flag straight through) and was then ignored, so in dev mode a
            // recursive listing silently came back one level deep. Same limits
            // as the Rust command: depth 5, 500 entries.
            const MAX_ENTRIES = 500
            const MAX_DEPTH = 5
            const walk = (dir: string, depth: number): void => {
              let items: Dirent[]
              try {
                items = readdirSync(dir, { withFileTypes: true })
              } catch {
                return
              }
              for (const item of items) {
                if (entries.length >= MAX_ENTRIES) return
                const fullPath = join(dir, item.name)
                try {
                  const stat = statSync(fullPath)
                  entries.push({ name: item.name, path: fullPath, size: stat.size, isDir: item.isDirectory(), modified: Math.floor(stat.mtimeMs / 1000) })
                } catch { continue }
                if (recursive && item.isDirectory() && depth < MAX_DEPTH) walk(fullPath, depth + 1)
              }
            }
            walk(resolved, 1)
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

      // API: System health (mirrors the Rust `system_health` command so the
      // Settings → Troubleshoot "Re-probe" button works under `npm run dev`
      // too. The plain dev server previously had no /local-api/system-health,
      // so the button errored (konata-session 2026-06-07). Dev-only — the
      // packaged app uses the real Rust probe.
      server.middlewares.use('/local-api/system-health', async (_req, res) => {
        const os = require('os')
        const probe = async (url: string, endpoint: string) => {
          try {
            const r = await fetch(url)
            return { status: r.ok ? 'ok' : 'error', detail: `HTTP ${r.status}`, endpoint }
          } catch (e: any) {
            return { status: 'unreachable', detail: String(e?.message || e), endpoint }
          }
        }
        const ollamaBase = (process.env.OLLAMA_HOST && /^https?:/.test(process.env.OLLAMA_HOST))
          ? process.env.OLLAMA_HOST.replace(/\/+$/, '')
          : 'http://localhost:11434'
        const [ollama, comfyui, lm_studio] = await Promise.all([
          probe(`${ollamaBase}/api/tags`, ollamaBase),
          probe('http://localhost:8188/system_stats', 'http://localhost:8188'),
          probe('http://localhost:1234/v1/models', 'http://localhost:1234'),
        ])
        let vram_total_gb: number | null = null
        let vram_free_gb: number | null = null
        try {
          const { execSync } = require('child_process')
          const out = execSync('nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits',
            { encoding: 'utf8', timeout: 4000 })
          const [tot, free] = String(out).trim().split('\n')[0].split(',').map((s: string) => parseFloat(s.trim()))
          if (!isNaN(tot)) vram_total_gb = +(tot / 1024).toFixed(1)
          if (!isNaN(free)) vram_free_gb = +(free / 1024).toFixed(1)
        } catch { /* no nvidia-smi → null */ }
        let disk_free_gb = 0
        try {
          const fs: any = require('fs')
          if (fs.statfsSync) {
            const st = fs.statfsSync(os.homedir())
            disk_free_gb = +((st.bavail * st.bsize) / 1e9).toFixed(1)
          }
        } catch { /* statfs unavailable */ }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          version: 'dev',
          host: {
            os: process.platform, os_version: os.release(), arch: process.arch,
            cpu_count: os.cpus().length, ram_gb: +(os.totalmem() / 1e9).toFixed(1),
            disk_free_gb, vram_total_gb, vram_free_gb,
          },
          ollama, comfyui, lm_studio,
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

      // API: Install faster-whisper (§24.9 — dev-mode parity with the Tauri
      // install_whisper command). Pip-installs into the dev Python. The
      // persistent whisper server is spawned once at dev-server start, so a
      // restart of `npm run dev` is needed to load the model after install
      // (the Tauri build starts the server in-process post-install).
      const whisperInstallLogs: string[] = []
      let whisperInstallStatus: 'idle' | 'installing' | 'complete' | 'error' = 'idle'
      let whisperInstallError = ''
      server.middlewares.use('/local-api/install-whisper', (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: whisperInstallStatus, error: whisperInstallError, logs: whisperInstallLogs.slice(-30) }))
          return
        }
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        if (whisperInstallStatus === 'installing') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'already_installing' }))
          return
        }
        whisperInstallStatus = 'installing'
        whisperInstallError = ''
        whisperInstallLogs.length = 0
        const wlog = (msg: string) => {
          whisperInstallLogs.push(msg)
          if (whisperInstallLogs.length > 200) whisperInstallLogs.shift()
          console.log(`[Whisper Install] ${msg}`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'started' }))
        wlog(`Installing faster-whisper via ${pythonBin}…`)
        const pip = spawn(pythonBin, ['-m', 'pip', 'install', '--progress-bar', 'off', '--no-input', 'faster-whisper'], {
          stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
        })
        pip.stdout?.on('data', (d) => d.toString().split('\n').forEach((l: string) => l.trim() && wlog(l.trim())))
        pip.stderr?.on('data', (d) => d.toString().split('\n').forEach((l: string) => l.trim() && wlog(l.trim())))
        pip.on('exit', (code) => {
          if (code === 0) {
            whisperInstallStatus = 'complete'
            wlog('faster-whisper installed. Restart `npm run dev` to load the STT model.')
          } else {
            whisperInstallStatus = 'error'
            whisperInstallError = `pip install failed (exit ${code})`
            wlog(whisperInstallError)
          }
        })
        pip.on('error', (err) => {
          whisperInstallStatus = 'error'
          whisperInstallError = String(err)
          wlog(`ERROR: ${whisperInstallError}`)
        })
      })

      // API: Install neural TTS (Piper) — honest dev-mode stub. Bug B10: the
      // real install (pip install piper-tts + voice-model download) runs only in
      // the packaged Tauri app, so the browser surface reports it as desktop-only
      // (POST kickoff + GET status both error) instead of throwing
      // "Unknown backend command: install_tts".
      server.middlewares.use('/local-api/install-tts', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'error',
          error: 'Neural TTS install is only available in the desktop app. Run the packaged Locally Uncensored to install Piper TTS.',
          logs: [],
        }))
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
  // §1.6: `stripConsolePlugin` (apply:'build') removes console.log/info/debug
  // from production output while keeping warn/error. It replaces the old
  // `esbuild: { drop, pure }` block, which was silently ignored under
  // Vite 8's oxc minifier (the build warned about exactly that) — so
  // console.* used to ship. See the plugin definition above for why oxc's
  // own dropConsole can't be used (all-or-nothing, no warn/error carve-out).
  plugins: [react(), tailwindcss(), stripConsolePlugin(), comfyLauncher()],
  server: {
    // The Rust build tree churns thousands of files per `cargo build`; watching
    // it starves the dev server on a `tauri:dev` run.
    watch: { ignored: ['**/src-tauri/target/**'] },
    port: DEV_PORT,
    cors: true,
    // `true` switched Vite's host-header check off completely. This dev server
    // is not a developer convenience here — setup.sh / start.bat ship it as the
    // user's runtime, with /local-api/shell-execute and /local-api/execute-code
    // mounted on it, so any web page the user happened to have open could point
    // its own domain at 127.0.0.1 and talk to those endpoints as if it were the
    // app. Vite waves through bare IP literals and localhost regardless, so the
    // job of this list is only to withhold arbitrary DNS names; reaching the
    // dev server over a LAN hostname is an opt-in that belongs in here by name.
    allowedHosts: ['localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        // Issue #31: honour OLLAMA_HOST so `OLLAMA_HOST=0.0.0.0:11434 npm run dev`
        // and remote Ollama setups (Docker, LAN, homelab) just work in dev mode
        // too. Accept bare `host:port`, scheme-less host, or full URL.
        target: (() => {
          const raw = (process.env.OLLAMA_HOST || '').trim()
          if (!raw) return 'http://localhost:11434'
          if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
          return `http://${raw.replace(/\/+$/, '')}`
        })(),
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
