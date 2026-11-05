/**
 * Review N12: "nothing leaves the phone" said more than is true. The backup
 * of the phone itself (iCloud, a transfer to a new phone) may take the app
 * folder with the chats along, Remote sends messages to the desktop, an own
 * provider key sends them to that provider. The Privacy page says all of
 * that; the sentences that advertise must not say the opposite.
 *
 * Run: npx vitest run src/mobile/__tests__/honest-privacy-texts.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mobileReleaseNoteFor } from '../strings/release-notes'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../strings')

describe('what the app says about data leaving the phone', () => {
  it('no text of the phone shell claims that nothing leaves the phone', () => {
    const hits: string[] = []
    const names = readdirSync(DIR).filter((name) => name.endsWith('.ts'))
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) {
      const text = readFileSync(join(DIR, name), 'utf8')
      for (const m of text.matchAll(/nothing (?:ever )?leaves (?:the|this|your) phone/gi)) hits.push(`${name}: ${m[0]}`)
    }
    expect(hits).toEqual([])
  })

  it('the first release note and the welcome page say the narrow thing that is true', () => {
    expect(mobileReleaseNoteFor('3.0.7')?.items[0]).toBe('Chat with models that run on this phone. No connection needed, and such a chat is not sent to any server.')
    expect(readFileSync(join(DIR, 'models.ts'), 'utf8')).toContain('then chat without a connection. A chat with a model on this phone is not sent to any server.')
  })

  it('the Privacy page still says that the backup of the phone may take the app folder along', () => {
    const settings = readFileSync(join(DIR, 'settings.ts'), 'utf8')
    expect(settings).toContain('The backup of the phone itself may take that folder along.')
    expect(settings).toContain('Keys, passwords and your sign in are never written into it.')
  })
})
