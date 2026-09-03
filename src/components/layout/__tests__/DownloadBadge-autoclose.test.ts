/**
 * Regression: the downloads tray opens itself when a download starts, but had
 * no way back. Cancel the download (or let the last file finish) and the panel
 * kept hanging over the app reading "No active downloads" until the user
 * happened to mousedown somewhere else. Seen live on 2026-07-26 while the tray
 * sat on top of the cloud retention banner.
 *
 * There is no render harness in this repo (no @testing-library), so this guards
 * the SOURCE for the three pieces of the fix, in the same style as
 * AppShell-backend-autoenable.test.ts. Since the rule moved into
 * lib/download-tray.ts, the three guarantees are also exercised directly in
 * src/lib/__tests__/download-tray.test.ts — read that one for the behaviour,
 * this one for "the component still wires it up". The end-to-end evidence is
 * the CDP run on the ship exe: tray opens on start, closes on cancel.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../DownloadBadge.tsx'), 'utf8')

describe('DownloadBadge tray auto-close', () => {
  // The rule itself moved into lib/download-tray.ts (it needed no effect, and
  // React 19 flags the two setStates the effects made — `set-state-in-effect`).
  // Its three guarantees are exercised as BEHAVIOUR in
  // src/lib/__tests__/download-tray.test.ts, transition for transition against
  // what the effects did. What is left to guard here is that the component
  // still applies that rule, and that the effects do not creep back in.
  it('remembers that the tray opened itself', () => {
    // open + "who opened it" are one value, so they cannot drift apart.
    expect(src).toMatch(/const \[tray, setTray\] = useState\(TRAY_CLOSED\)/)
    expect(src).toMatch(/const next = trayAfterPulse\(tray, seen, now\)/)
    expect(src).toMatch(/from '\.\.\/\.\.\/lib\/download-tray'/)
  })

  it('closes again when the list empties, but only if it opened itself', () => {
    // Both halves of the picture are fed in, and the comparison is against the
    // PREVIOUS one — that is what makes "a download started" and "the last row
    // went away" distinguishable at all.
    expect(src).toMatch(/const \[seen, setSeen\] = useState\(NO_PULSE\)/)
    expect(src).toMatch(/seen\.active !== totalActive \|\| seen\.any !== hasAny/)
    expect(src).toMatch(/const now = \{ active: totalActive, any: hasAny \}/)
    // No effect may reintroduce the write-back the rule was lifted out of.
    expect(src).not.toMatch(/setOpen\(/)
    expect(src).not.toMatch(/autoOpened/)
  })

  it('leaves a hand-opened tray alone', () => {
    // Clicking the trigger drops the flag, so the close branch skips it.
    expect(src).toMatch(/onClick=\{\(\) => setTray\(\{ open: !open, auto: false \}\)\}/)
  })
})
