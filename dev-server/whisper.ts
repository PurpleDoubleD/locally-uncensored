import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import os from 'os'
import { join, resolve } from 'path'
import type { RouteMount } from './routes'
import { pythonBin } from './python'
import { PROJECT_ROOT } from './paths'
import { parseJsonBody } from '../src/dev/http-body'
import { asString, errorText, prop } from '../src/types/json-guards'

/**
 * Der dauerhafte Whisper-Prozess und die vier Endpunkte an ihm.
 *
 * `onClose` ist der Haken, an dem der Prozess wieder stirbt. Er kommt von
 * aussen, weil nur dev-server/index.ts den echten `ViteDevServer` hat — und
 * weil ein Modul, das `server.httpServer` selbst braucht, wieder nur mit
 * einem laufenden Vite-Server zu haben wäre.
 */
export function registerWhisperRoutes(routes: RouteMount, onClose: (cb: () => void) => void): void {
  // --- Persistent Whisper STT Server ---
  // Spawns whisper_server.py ONCE, keeps model loaded in memory.
  // Subsequent transcriptions are fast (~2s) instead of re-loading (~170s).

  let whisperProc: ChildProcess | null = null
  let whisperReady = false
  let whisperBackend: string | null = null
  let whisperBuffer = ''
  // Der Whisper-Server ist ein FREMDER Prozess (public/whisper_server.py):
  // was er auf stdout schreibt, ist unbekannte Form, bis es geprüft ist.
  const whisperQueue: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

  function handleWhisperLine(line: string) {
    const parsed = parseJsonBody(line)
    if (!parsed.ok) return // keine JSON-Zeile — der Server loggt auch Text
    const data = parsed.value
    const status = asString(prop(data, 'status'))
    if (status === 'ready') {
      whisperReady = true
      whisperBackend = asString(prop(data, 'backend')) || 'faster-whisper'
      console.log(`[Whisper] Server ready (backend: ${whisperBackend})`)
      return
    }
    if (status === 'error' && !whisperReady) {
      console.error('[Whisper] Server failed to start:', errorText(prop(data, 'error')))
      return
    }
    // Route response to the oldest queued request
    const pending = whisperQueue.shift()
    if (pending) {
      clearTimeout(pending.timer)
      pending.resolve(data)
    }
  }

  function sendWhisperCommand(cmd: object, timeoutMs = 30000): Promise<unknown> {
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
  const whisperScript = resolve(PROJECT_ROOT, 'public', 'whisper_server.py')
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
          try { whisperProc.stdin?.write('{"action":"quit"}\n') } catch { /* stdin schon zu — der SIGKILL unten raeumt auf */ }
          setTimeout(() => {
            try { whisperProc?.kill('SIGKILL') } catch { /* schon beendet */ }
          }, 2000)
        }
      }
      onClose(killWhisper)
    } catch {
      console.log('[Whisper] faster-whisper not installed — STT disabled')
    }
  }

  // API: Check if Whisper is available
  routes.use('/local-api/transcribe-status', (req, res) => {
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
  routes.use('/local-api/install-whisper', (req, res) => {
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
  routes.use('/local-api/install-tts', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'error',
      error: 'Neural TTS install is only available in the desktop app. Run the packaged Locally Uncensored to install Piper TTS.',
      logs: [],
    }))
  })

  // API: Transcribe audio via persistent Whisper server
  routes.use('/local-api/transcribe', (req, res) => {
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
        writeFileSync(tmpFile, audioBuffer)

        console.log(`[Whisper] Transcribing: ${tmpFile} (${(audioBuffer.length / 1024).toFixed(1)} KB)`)
        const result = await sendWhisperCommand(
          { action: 'transcribe', path: tmpFile.replace(/\\/g, '/') },
          60000,
        )

        // Clean up temp file
        try { unlinkSync(tmpFile) } catch { /* ignore */ }

        const whisperError = errorText(prop(result, 'error'))
        if (whisperError) {
          console.error('[Whisper] Transcription error:', whisperError)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: whisperError, transcript: '' }))
          return
        }

        const transcript = asString(prop(result, 'transcript')) ?? ''
        const language = asString(prop(result, 'language')) ?? 'en'
        console.log(`[Whisper] Transcribed: "${transcript.substring(0, 80)}..." (lang: ${language})`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ transcript, language }))
      } catch (err) {
        console.error('[Whisper] Request error:', errorText(err))
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: errorText(err) || String(err), transcript: '' }))
      }
    })
  })
}
