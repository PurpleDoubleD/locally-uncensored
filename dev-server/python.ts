import { execSync } from 'child_process'

/**
 * Der Python-Interpreter dieses Rechners.
 *
 * Eigenes Modul, weil ihn ZWEI Dinge brauchen, die sonst nichts miteinander zu
 * tun haben: der ComfyUI-Starter und der Whisper-Server. In eines von beiden
 * gelegt, hinge das andere daran.
 */
// Shared Python binary resolver — filters Windows Store alias, caches result
export const pythonBin = (() => {
  if (process.platform !== 'win32') return 'python3'
  try {
    const paths = execSync('where python', { encoding: 'utf8' }).trim().split('\n')
    const real = paths.find((p: string) => !p.includes('WindowsApps'))
    return real ? real.trim() : 'python'
  } catch { return 'python' }
})()
console.log(`[Python] Resolved: ${pythonBin}`)

