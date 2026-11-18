/**
 * Mobile, acceptance on Android with 8 GB, B7: a small model that knows the
 * date still called 2026 "the future" and searched for "2024".
 *
 * Run: npx vitest run src/lib/__tests__/phone-clock-line.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let mobile = false
vi.mock('../device-kind', async (orig) => ({ ...(await orig() as object), isMobile: () => mobile }))

import { hostClockLine, todayIsLaterNote } from '../host-platform'

const AT = new Date(2026, 9, 9, 12, 0, 0)

afterEach(() => { mobile = false })

describe('the date in the system prompt of the agent', () => {
  it('the agent loop appends the clock line to every system prompt, phone included', () => {
    const hook = readFileSync(resolve(__dirname, '../../hooks/useAgentChat.ts'), 'utf8')
    // Since 3.0.8 (A7) the clock rides in one note with memories and
    // retrieval: behind the user's message on a desktop, at the end of the
    // system prompt on a phone. Either way every run gets it.
    expect(hook).toContain('clock: agentClockLine()')
    expect(hook).toContain('if (phoneSystemNote && contextNote) agentSystemPrompt += `\\n\\n${contextNote}`')
  })

  it('names the day, computed on the device', () => {
    const line = hostClockLine(AT)
    expect(line).toContain('Friday')
    expect(line).toContain('9 October 2026')
  })

  it('on the desktop the line is word for word what it was', () => {
    const line = hostClockLine(AT)
    expect(line.startsWith('Date and time at the start of this run: Friday')).toBe(true)
    expect(line.endsWith('Trust this line; there is no clock tool.')).toBe(true)
    expect(line).not.toContain('Your own knowledge')
  })

  it('on a phone it also says what follows from the date', () => {
    mobile = true
    const line = hostClockLine(AT)
    expect(line).toContain('Date and time at the start of this run: Friday')
    expect(line).toContain('Trust this line; there is no clock tool. The current year is 2026.')
    expect(line).toContain('never call something up to this date "in the future"')
    expect(line).toContain('write 2026 in the query')
    expect(line.split('\n')).toHaveLength(1)
    expect(line).not.toMatch(/[\u2013\u2014]/)
  })

  it('the note follows the clock', () => {
    expect(todayIsLaterNote(new Date(2027, 0, 1))).toContain('The current year is 2027.')
  })
})
