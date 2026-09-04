/**
 * The one line that says "the file on disk is not the diff you approved" has
 * to reach the user.
 *
 * Review 2026-08-14. applyStagedChange writes that line into the chat log with
 * a comment saying it is there "so the user sees a confirmation in the main
 * pane", and then flagged it `hidden: true`. Both renderers drop hidden
 * messages, and MessageList drops every system role on top of that, so the
 * notice rendered nowhere at all. The Pending row just disappeared, exactly as
 * it does after a clean apply, and with codexAutoApply on the user never even
 * clicked. There is no undo on that write.
 *
 * The other wrong answer would have been to let it render as an assistant
 * bubble: that claims the model said it (the same rule useCodex states where
 * it refuses to author answer text on the model's behalf). So it renders as a
 * plain notice line, and it stays role:'system' so the payload builder keeps
 * dropping it and the model never sees it.
 *
 * Run: npx vitest run src/components/chat/__tests__/staged-apply-notice-reaches-the-user.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const codexView = read('../CodexView.tsx')
const stagedApply = read('../../../lib/staged-apply.ts')
const useCodex = read('../../../hooks/useCodex.ts')
const chatTypes = read('../../../types/chat.ts')

describe('the notice is written to be seen', () => {
  it('carries no hidden flag any more', () => {
    // Comments stripped: the doc above the call quotes the old flag on purpose,
    // so the whole file would match while the code is clean.
    const codeOnly = stagedApply
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    expect(codeOnly).not.toMatch(/hidden:\s*true/)
  })

  it('marks a merged apply as something to act on, a clean one as confirmation', () => {
    expect(stagedApply).toContain("notice: merged > 0 ? 'warn' : 'info'")
    expect(stagedApply).toMatch(/not byte for byte the diff you approved/)
  })

  it('the flag exists on the message type, so this is not a stray property', () => {
    expect(chatTypes).toMatch(/notice\?: 'info' \| 'warn'/)
  })
})

describe('the coding view renders it as a notice, not as the model talking', () => {
  it('has a branch for it before the bubble branch', () => {
    const list = codexView.slice(codexView.indexOf('messages.filter(msg => !msg.hidden)'))
    const branch = list.indexOf("msg.role === 'system' && msg.notice")
    const bubble = list.indexOf("msg.role === 'user' ? 'flex-row-reverse' : ''")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(bubble)
  })

  it('a warn notice looks different from a confirmation', () => {
    // Hier stand einmal `toContain('amber')`. Das war schon vorher der
    // schwaechere Test: er nagelte eine Farbe fest statt der Aussage, und die
    // Farbe hat David am 04.09.2026 aus der ganzen Oberflaeche geworfen
    // ("kein gelb mehr ohne farbe"). Seitdem gibt es zwei Toene und keinen
    // dritten (`lib/hinweis.ts`), und welcher der beiden hier steht, ist eine
    // Frage der Regel, nicht dieses Tests. Was der Test schuldet, ist die
    // urspruengliche Aussage: die zwei Faelle werden ueberhaupt
    // unterschieden, und der Satz des Nutzers steht drin.
    const branch = codexView.slice(
      codexView.indexOf("msg.role === 'system' && msg.notice"),
      codexView.indexOf('// Slash commands:'),
    )
    expect(branch).toContain("const warn = msg.notice === 'warn'")
    // Berechnet allein reicht nicht, die Unterscheidung muss auch etwas
    // steuern: ohne eine zweite Fundstelle waere `warn` totes Holz.
    expect((branch.match(/\bwarn\b/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(branch).toContain('AlertTriangle')
    expect(branch).toContain('{msg.content}')
  })
})

describe('und im normalen Verlauf steht dieselbe Zeile', () => {
  // Der Befund oben war fuer den Code-Verlauf aufgeschrieben, die Meldung
  // erreicht den Nutzer aber auf beiden Oberflaechen. MessageList rendert
  // sie mit derselben Regel, und ohne diese Wache haette der Umbau vom
  // 04.09.2026 die eine Seite still auf eine andere Form ziehen koennen.
  const list = read('../MessageList.tsx')

  it('rendert den Satz als Zeile, nicht als Blase', () => {
    expect(list).toContain("message.role === 'system' && message.notice")
    expect(list).toContain('data-testid="chat-notice"')
    expect(list).toContain('{message.content}')
  })

  it('nimmt die zwei Toene aus der einen Regel, und keinen dritten', () => {
    expect(list).toContain("ton={message.notice === 'warn' ? 'fehler' : 'ruhig'}")
    expect(list).not.toMatch(/(?:amber|yellow)-/)
  })
})

describe('and the model still never sees it', () => {
  it('the payload builder drops the system role', () => {
    expect(useCodex).toContain("m.role !== 'system'")
  })
})
