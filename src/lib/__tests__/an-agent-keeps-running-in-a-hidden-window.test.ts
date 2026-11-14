import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 14.11. CA bench: Kimi's run stood still for 13 minutes in CO10 with the page
// suspended: no request, no socket, and even the 60 s stream idle watchdog did
// not fire. WebKit fully suspends a web view that is not in a window unless
// the window says otherwise, and LU never said. An agent works while you do
// something else, so its window must not be suspended.
const CONFIGS = ['tauri.conf.json', 'tauri.macos.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json']

describe('the main window keeps running in the background', () => {
  for (const name of CONFIGS) {
    it(`${name} turns background throttling off`, () => {
      const conf = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri', name), 'utf8'))
      const windows: Array<{ backgroundThrottling?: string }> = conf.app.windows
      expect(windows.length).toBeGreaterThan(0)
      for (const w of windows) expect(w.backgroundThrottling).toBe('disabled')
    })
  }
})
