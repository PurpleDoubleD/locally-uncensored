/**
 * Die zweite Haelfte des P1-Fehlfunds vom 04.09.2026.
 *
 * Der Proxy gibt eine abgelehnte Verbindung als
 *   Response(503, {"error": "proxy_localhost_stream_chunked: error sending
 *   request for url (http://127.0.0.1:8127/v1/chat/completions)"})
 * zurueck. Bis zu diesem Tag hat das niemanden gestoert, weil die Meldung ihr
 * Wettrennen gegen die Schlussmarke des Streams verlor und der Nutzer
 * stattdessen "the connection dropped, check your network" las. Falsch, aber
 * harmlos aussehend. Seit das Rennen entschieden ist (proxy.rs), kommt die
 * echte Zeile an, und jetzt muss jeder Anbieter sie uebersetzen. Sonst steht
 * ein Rust-Befehlsname im Chatfenster, und das ist Hausregel-Bruch.
 *
 * Lauf: npx vitest run src/lib/__tests__/kein-rust-name-im-chatfenster.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  hostOf,
  isLocalTransportFailure,
  localBackendUnreachableMessage,
} from '../local-backend-transport'

const ROH =
  'proxy_localhost_stream_chunked: error sending request for url (http://127.0.0.1:8127/v1/chat/completions)'

describe('hostOf', () => {
  it('schneidet Schema und Pfad weg und laesst den Port stehen', () => {
    expect(hostOf('http://127.0.0.1:8127/v1')).toBe('127.0.0.1:8127')
    expect(hostOf('https://192.168.0.54:11434')).toBe('192.168.0.54:11434')
    expect(hostOf('http://localhost:1234/v1/chat/completions')).toBe('localhost:1234')
  })

  it('gibt bei Unsinn eine leere Zeichenkette statt zu werfen', () => {
    expect(hostOf('')).toBe('')
    expect(hostOf(undefined as unknown as string)).toBe('')
  })
})

describe('isLocalTransportFailure', () => {
  it('erkennt jede Form, in der eine abgelehnte Verbindung ankommt', () => {
    for (const msg of [
      ROH,
      'error sending request for url (http://127.0.0.1:8127/v1/chat/completions): connection refused',
      'TypeError: Failed to fetch http://127.0.0.1:8127/v1/chat/completions',
      'ECONNREFUSED 127.0.0.1:8127',
      'tcp connect error 127.0.0.1:8127',
    ]) {
      expect(isLocalTransportFailure(msg, 'http://127.0.0.1:8127/v1')).toBe(true)
    }
  })

  it('laesst die eigenen Worte des Servers in Ruhe', () => {
    const echt = 'HTTP 400: {"error":"context length exceeded"}'
    expect(isLocalTransportFailure(echt, 'http://127.0.0.1:8127/v1')).toBe(false)
  })

  it('schiebt den Fehler eines FREMDEN Servers nicht diesem hier zu', () => {
    // Zwei lokale Server nebeneinander: wer 11434 nicht erreicht, soll nicht
    // hoeren, er solle 8127 neu starten.
    const andrer = 'error sending request for url (http://127.0.0.1:11434/api/chat)'
    expect(isLocalTransportFailure(andrer, 'http://127.0.0.1:8127/v1')).toBe(false)
    expect(isLocalTransportFailure(andrer, 'http://127.0.0.1:11434')).toBe(true)
  })

  it('faellt bei einer leeren Adresse auf falsch zurueck, statt alles zu treffen', () => {
    expect(isLocalTransportFailure(ROH, '')).toBe(false)
  })
})

describe('localBackendUnreachableMessage', () => {
  const satz = localBackendUnreachableMessage('LM Studio', 'http://127.0.0.1:1234/v1')

  it('nennt den Anbieter, die Adresse und den Weg in die Einstellungen', () => {
    expect(satz).toContain('LM Studio')
    expect(satz).toContain('127.0.0.1:1234')
    expect(satz).toContain('Settings, AI Backends')
  })

  it('redet bei einer Adresse auf diesem Rechner NICHT vom Netz', () => {
    expect(satz).not.toMatch(/network/i)
    expect(satz).not.toMatch(/internet/i)
    expect(satz).not.toMatch(/connection dropped/i)
  })

  it('traegt keinen Rust-Befehlsnamen und keinen Bindestrich-Gedankenstrich', () => {
    expect(satz).not.toContain('proxy_localhost')
    expect(satz).not.toMatch(/[–—]/)
  })
})
