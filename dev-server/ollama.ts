import { spawn, execSync } from 'child_process'

/** Startet Ollama beim Hochfahren des Dev-Servers, wenn es nicht schon läuft. */
export function autostartOllama(): void {
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
}
