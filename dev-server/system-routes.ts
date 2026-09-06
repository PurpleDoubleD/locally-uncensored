import { execSync } from 'child_process'
import { statfsSync } from 'fs'
import os from 'os'
import type { RouteMount } from './routes'
import { errorText } from '../src/types/json-guards'

/** Die vier Auskunfts-Endpunkte über den Rechner. Sie lesen nur. */
export function registerSystemRoutes(routes: RouteMount): void {
  // API: System info
  routes.use('/local-api/system-info', (_req, res) => {
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
  routes.use('/local-api/system-health', async (_req, res) => {
    const probe = async (url: string, endpoint: string) => {
      try {
        const r = await fetch(url)
        return { status: r.ok ? 'ok' : 'error', detail: `HTTP ${r.status}`, endpoint }
      } catch (e) {
        return { status: 'unreachable', detail: errorText(e) || String(e), endpoint }
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
      const out = execSync('nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits',
        { encoding: 'utf8', timeout: 4000 })
      const [tot, free] = String(out).trim().split('\n')[0].split(',').map((s: string) => parseFloat(s.trim()))
      if (!isNaN(tot)) vram_total_gb = +(tot / 1024).toFixed(1)
      if (!isNaN(free)) vram_free_gb = +(free / 1024).toFixed(1)
    } catch { /* no nvidia-smi → null */ }
    let disk_free_gb = 0
    try {
      const st = statfsSync(os.homedir())
      disk_free_gb = +((Number(st.bavail) * Number(st.bsize)) / 1e9).toFixed(1)
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
  routes.use('/local-api/process-list', (_req, res) => {
    // Simple stub — full process list needs native code
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ processes: [], count: 0, note: 'Full process list available in Tauri build only' }))
  })

  // API: Screenshot
  routes.use('/local-api/screenshot', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Screenshot available in Tauri build only' }))
  })
}
