import { spawn, execSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import os from 'os'
import { join } from 'path'
import type { RouteMount } from './routes'
import { requirePost, withJsonBody } from './http'
import { bodyNumber, bodyString } from '../src/dev/http-body'

/**
 * Die beiden Endpunkte, die aus einem Request heraus einen Prozess starten.
 * Zusammen, weil sie dieselbe Form haben (spawn ohne Shell, Zeitgrenze,
 * SIGKILL) und dieselbe Risikoklasse — sie sind der Grund, warum der Wächter
 * vor /local-api steht.
 */
export function registerExecRoutes(routes: RouteMount): void {
  // API: Execute Python code
  routes.use('/local-api/execute-code', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const code = bodyString(body, 'code')
        const timeoutMs = bodyNumber(body, 'timeout')
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing code parameter' }))
          return
        }

        const tmpDir = join(os.tmpdir(), 'agent-exec-' + Date.now())
        mkdirSync(tmpDir, { recursive: true })

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
          try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }

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

  // --- New Agent Tool Endpoints (Phase 1) ---

  // API: Shell execute
  routes.use('/local-api/shell-execute', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const command = bodyString(body, 'command')
        const cwd = bodyString(body, 'cwd')
        const timeoutMs = bodyNumber(body, 'timeout')
        const shellType = bodyString(body, 'shell')
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

}
