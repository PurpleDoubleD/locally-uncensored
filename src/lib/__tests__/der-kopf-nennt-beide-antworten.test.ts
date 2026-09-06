/**
 * Der Kopf einer Datei darf nicht etwas anderes sagen als die Datei.
 *
 * src/lib/local-backend-transport.ts trug bis zur Nachlese den Kopf aus der
 * Runde davor: "One reading of 'the local backend did not answer', shared by
 * everyone who talks to a server on this machine or on the LAN." In derselben
 * Datei steht seit derselben Runde `remoteBackendUnreachableMessage`, deren
 * eigener Block mit "The same answer for a backend that is NOT on this machine
 * or the LAN" anfaengt. Wer den Kopf liest und danach eine Antwort fuer einen
 * fremden Host sucht, sucht sie woanders, weil der Kopf ihm gesagt hat, hier
 * gebe es sie nicht.
 *
 * Der Test haelt den Kopf gegen das, was die Datei wirklich anbietet.
 *
 * Run: npx vitest run src/lib/__tests__/der-kopf-nennt-beide-antworten.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const datei = resolve(__dirname, '..', 'local-backend-transport.ts')
const quelle = readFileSync(datei, 'utf8')

/** Der Modulkopf, als fortlaufender Satz statt als Sternchenspalte. */
const kopf = quelle
  .slice(0, quelle.indexOf('*/'))
  .split('\n')
  .map((z) => z.replace(/^\s*\/?\*+/, '').trim())
  .join(' ')
  .replace(/\s+/g, ' ')

describe('der Kopf von local-backend-transport.ts', () => {
  it('die Datei gibt wirklich zwei Antworten, eine nahe und eine ferne', () => {
    expect(quelle).toContain('export function localBackendUnreachableMessage')
    expect(quelle).toContain('export function remoteBackendUnreachableMessage')
  })

  it('und der Kopf nennt beide', () => {
    expect(kopf).toContain('localBackendUnreachableMessage')
    expect(kopf).toContain('remoteBackendUnreachableMessage')
  })

  it('er sperrt die Datei nicht mehr auf diese Maschine und das LAN ein', () => {
    // Genau der Satz, der dort stand. Er beschreibt die Datei von vor der
    // letzten Runde.
    expect(kopf).not.toContain('talks to a server on this machine or on the LAN')
  })

  it('die ferne Antwort schickt niemanden zu einem Server, den er nicht betreibt', () => {
    // Die Gegenprobe zur Aussage des Kopfes: die beiden Saetze sind wirklich
    // verschieden, sonst waere die ganze Unterscheidung Schmuck.
    const fern = quelle.slice(quelle.indexOf('export function remoteBackendUnreachableMessage'))
    expect(fern).not.toContain('Start it and send again')
    expect(fern).toContain('check your network')
    const nah = quelle.slice(
      quelle.indexOf('export function localBackendUnreachableMessage'),
      quelle.indexOf('export function remoteBackendUnreachableMessage'),
    )
    expect(nah).toContain('Start it and send again')
    expect(nah).not.toContain('check your network')
  })
})
