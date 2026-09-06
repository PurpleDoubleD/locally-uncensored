/**
 * Wenn die App die Modellwahl des Nutzers selbst ersetzt, sagt sie es.
 *
 * Gegenprobe G1, 04.09.2026, echter Windows-Build, zweimal reproduziert
 * (02:17:41 und 02:23:36): der Testkunde nimmt den Provider LM Studio wieder
 * heraus. Das gewaehlte Modell gehoerte dazu, verschwindet also aus der Liste,
 * und die Modusregel greift zum ersten Eintrag, den sie findet. Beide Male war
 * das `G1-Kaputt-Q4_K_M`, eine absichtlich kaputte GGUF-Datei. Die
 * Models-Seite schrieb ACTIVE daneben, der Waehlerknopf nannte sie, auf Port
 * 8127 lief nichts, und kein Wort dazu stand irgendwo auf dem Schirm.
 *
 * Ein Moduswechsel ist ausgenommen. Den hat der Nutzer selbst umgelegt, der
 * Schalter steht sichtbar oben, und eine Zeile darueber waere Laerm.
 *
 * Run: npx vitest run src/lib/__tests__/die-app-sagt-wenn-sie-selbst-umwaehlt.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pickForMode, replacedBehindTheUsersBack } from '../active-model-mode'

const LM = { name: 'qwen2.5-0.5b', provider: 'openai' }
const KAPUTT = { name: 'G1-Kaputt-Q4_K_M', provider: 'openai' }
const PHI = { name: 'Phi-4-mini-instruct-Q4_K_M', provider: 'openai' }

describe('replacedBehindTheUsersBack', () => {
  it('der Fall aus G1: Provider raus, Wahl weg, erster Eintrag gezogen', () => {
    const vorher = LM.name
    const pick = pickForMode(vorher, [KAPUTT, PHI], 'local')
    expect(pick.change).toBe(true)
    expect(pick.next).toBe(KAPUTT.name)
    expect(replacedBehindTheUsersBack(vorher, pick, false)).toBe(true)
  })

  it('ein Moduswechsel zaehlt nicht, den hat der Nutzer umgelegt', () => {
    const pick = pickForMode(LM.name, [KAPUTT, PHI], 'local')
    expect(replacedBehindTheUsersBack(LM.name, pick, true)).toBe(false)
  })

  it('eine benannte Bitte zaehlt nicht, die kam vom Nutzer', () => {
    const pick = pickForMode(LM.name, [KAPUTT, PHI], 'local', PHI.name)
    expect(pick.usedRequest).toBe(true)
    expect(replacedBehindTheUsersBack(LM.name, pick, false)).toBe(false)
  })

  it('bleibt die Wahl stehen, gibt es nichts zu sagen', () => {
    const pick = pickForMode(PHI.name, [KAPUTT, PHI], 'local')
    expect(pick.change).toBe(false)
    expect(replacedBehindTheUsersBack(PHI.name, pick, false)).toBe(false)
  })

  it('eine leere Liste sagt nichts, sie weiss nichts', () => {
    const pick = pickForMode(PHI.name, [], 'local')
    expect(replacedBehindTheUsersBack(PHI.name, pick, false)).toBe(false)
  })

  it('ohne vorherige Wahl gibt es nichts zu ersetzen', () => {
    const pick = pickForMode(null, [KAPUTT, PHI], 'local')
    expect(pick.change).toBe(true)
    expect(replacedBehindTheUsersBack(null, pick, false)).toBe(false)
  })
})

describe('die Verdrahtung in AppShell', () => {
  const shell = readFileSync(resolve(__dirname, '..', '..', 'components', 'layout', 'AppShell.tsx'), 'utf8')

  it('die Regel wird gefragt und die Zeile gesagt', () => {
    expect(shell).toContain('replacedBehindTheUsersBack(activeModel, pick, modeFlipped)')
    expect(shell).toContain('announceChatModelReplaced(activeModel!, pick.next!)')
  })

  it('gefragt wird VOR dem Schreiben, sonst ist der alte Name schon weg', () => {
    const frage = shell.indexOf('replacedBehindTheUsersBack(activeModel, pick, modeFlipped)')
    const schreiben = shell.indexOf('if (pick.change) setActiveModel(pick.next)')
    expect(frage).toBeGreaterThan(0)
    expect(schreiben).toBeGreaterThan(frage)
  })
})
