import { spawn, execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'fs'
import os from 'os'
import { join, resolve as resolvePath } from 'path'
import type { RouteMount } from './routes'
import { requirePost, sendJson, withJsonBody } from './http'
import { bodyFlag, bodyNumber, bodyString } from '../src/dev/http-body'
import { devWorkspaceRoot } from '../src/lib/dev-fs-jail'
import { fenceShell } from './bench-sandbox'
import { adoptProcess, devTaskKill, devTaskList, devTaskStatus } from './shell-tasks'

/**
 * The folder a dev-server shell command runs in, the same rule as
 * shell.rs (cwd_in_workspace): the chat's workspace, a relative cwd inside it,
 * an absolute folder as it is. It used to be the Vite process folder (the
 * repo itself) whenever the model sent no cwd (C59 bench, 2026-11-09).
 */
export function devShellCwd(cwd?: string, chatId?: string, workingDirectory?: string, home = os.homedir()): string {
  const base = devWorkspaceRoot(home, chatId, workingDirectory)
  mkdirSync(base, { recursive: true })
  const want = (cwd ?? '').trim()
  if (!want) return base
  // resolve() keeps an absolute cwd as it is and joins a relative one onto base.
  const p = resolvePath(base, want)
  return existsSync(p) && statSync(p).isDirectory() ? p : base
}

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
        const fencedPy = fenceShell(pythonBin, ['-c', code])
        if ('refused' in fencedPy) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ stdout: '', stderr: fencedPy.refused, exitCode: 1 }))
          return
        }
        const proc = spawn(fencedPy.bin, fencedPy.args, {
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

        // The bench runs every shell command in its sandbox (bench-sandbox.ts).
        const fenced = fenceShell(shellBin, shellArgs)
        if ('refused' in fenced) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ stdout: '', stderr: fenced.refused, exitCode: 1 }))
          return
        }
        // T1, the same switch as the app's shell_execute: past the timeout the
        // command moves into the task registry (shell-tasks.ts) instead of
        // dying. It then gets a process group of its own on POSIX, so a kill
        // later takes its children along, and so does the dev server's exit
        // hook. The sandbox wrapping above stays as it is: the adopted process
        // is the fenced one.
        const handOver = bodyFlag(body, 'backgroundOnTimeout')
        const group = handOver && process.platform !== 'win32'
        const runCwd = devShellCwd(cwd, bodyString(body, 'chatId'), bodyString(body, 'workingDirectory'))
        const proc = spawn(fenced.bin, fenced.args, {
          cwd: runCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          detached: group,
        })

        let answered = false
        const timer = setTimeout(() => {
          if (handOver) {
            // Answer now with what came so far; the process runs on as a task.
            answered = true
            const soFar = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
            const taskId = adoptProcess({ proc, group, command, cwd: runCwd, soFar })
            sendJson(res, 200, { stdout, stderr, exitCode: -1, timedOut: true, taskId, timeoutMs: limit })
            return
          }
          killed = true
          try { proc.kill('SIGKILL') } catch { /* dead */ }
        }, limit)

        proc.stdout?.on('data', (d: Buffer) => { if (!answered) stdout += d.toString() })
        proc.stderr?.on('data', (d: Buffer) => { if (!answered) stderr += d.toString() })

        proc.on('exit', (exitCode) => {
          clearTimeout(timer)
          if (answered) return
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            stdout, stderr,
            exitCode: killed ? -1 : (exitCode ?? 1),
            timedOut: killed,
          }))
        })

        proc.on('error', (err: Error) => {
          clearTimeout(timer)
          if (answered) return
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ stdout: '', stderr: err.message, exitCode: 1, timedOut: false }))
        })
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })

  // T1: the tasks a timeout handed over. The same calls and shapes as the
  // app's shell_task_* commands, so the tool layer runs unchanged on the
  // bench. The body is the app's IPC payload, `{ args: { id } }`.
  const taskIdOf = (body: unknown): string => {
    const args = body && typeof body === 'object' ? (body as { args?: unknown }).args : undefined
    return bodyString(args, 'id') ?? ''
  }
  routes.use('/local-api/shell-task-status', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const id = taskIdOf(body)
      const s = devTaskStatus(id)
      if (!s) return sendJson(res, 404, { error: `task not found: ${id}` })
      sendJson(res, 200, s)
    })
  })
  routes.use('/local-api/shell-task-kill', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const id = taskIdOf(body)
      const r = devTaskKill(id)
      if (!r) return sendJson(res, 404, { error: `task not found: ${id}` })
      sendJson(res, 200, r)
    })
  })
  routes.use('/local-api/shell-task-list', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, () => sendJson(res, 200, { tasks: devTaskList() }))
  })
}
