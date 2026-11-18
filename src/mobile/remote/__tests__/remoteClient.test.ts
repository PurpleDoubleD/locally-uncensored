import { afterEach, describe, expect, it } from 'vitest'
import {
  RemoteBackendError,
  RemoteConnectionLostError,
  RemoteInvalidCodeError,
  RemoteMemoryRevokedError,
  RemoteNotLuError,
  RemoteProtocolError,
  RemoteRateLimitedError,
  RemoteSessionExpiredError,
  RemoteTimeoutError,
  RemoteUnreachableError,
  HOST_NAME_MAX,
  cleanHostName,
  createChatStreamParser,
  createRemoteClient,
  isToolsUnsupported,
  parseRetryAfterSeconds,
  resolveThinkFlag,
  type RemoteClient,
  type RemoteFetch,
} from '../remoteClient'
import { JWT_TTL_SECS, MAX_SESSION_SECS, startFakeDesktop, type FakeDesktop } from './fakeDesktop'

let desktop: FakeDesktop | null = null
afterEach(async () => {
  await desktop?.stop()
  desktop = null
})

/** Client mit eigenem Token-Fach, wie der Store es spaeter haelt. */
function clientFor(d: FakeDesktop, extra: { fetch?: RemoteFetch; timeouts?: Record<string, number> } = {}) {
  const session = { token: '' as string, seen: [] as string[] }
  const client: RemoteClient = createRemoteClient({
    baseUrl: d.url,
    getToken: () => session.token,
    onToken: (t) => {
      session.token = t
      session.seen.push(t)
    },
    ...extra,
  })
  return { client, session }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

describe('Rechnername', () => {
  it('liest den Namen, wenn der Desktop einen schickt, und kuerzt Unfug', async () => {
    desktop = await startFakeDesktop({ hostname: '  Davids\u0007 MacBook  ' })
    const { client } = clientFor(desktop)
    await client.pair('123456')
    expect((await client.checkSession()).hostName).toBe('Davids MacBook')
    expect(cleanHostName('x'.repeat(200)).length).toBeLessThanOrEqual(HOST_NAME_MAX)
    expect(cleanHostName(42)).toBe('')
    expect(cleanHostName('<b>pc</b>')).toBe('<b>pc</b>')
  })
})

describe('Koppeln', () => {
  it('prueft die Adresse, tauscht den Code gegen ein Token und liest damit Modelle und Konfiguration', async () => {
    desktop = await startFakeDesktop({ systemPrompt: 'Be brief.' })
    const { client, session } = clientFor(desktop)

    await client.probe()
    const token = await client.pair('123456')
    expect(token).toBe(session.token)
    expect(session.seen).toEqual([token])

    expect(await client.checkSession()).toEqual({ app: 'LU', version: '3.0.5', connectedDevices: 1, hostName: '', features: [], lanBlocked: false })
    expect(await client.listModels()).toEqual(['qwen3:8b', 'gemma4:e4b'])
    expect(await client.getConfig()).toEqual({
      model: 'qwen3:8b',
      systemPrompt: 'Be brief.',
      platformLine: 'This machine runs macOS and shell_execute runs bash.',
      // 3.1.2 (A39): a desktop that says nothing shares the clock.
      shareClock: true,
    })
    expect(await client.getPermissions()).toEqual({ filesystem: false, downloads: false, process_control: false, shell: false })
  })

  it('nimmt einen Code mit Leerzeichen an, wie er vom Bildschirm abgelesen wird', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await expect(client.pair('123 456')).resolves.toBeTruthy()
  })

  it('meldet einen falschen Code als RemoteInvalidCodeError mit lesbarem Text', async () => {
    desktop = await startFakeDesktop()
    const { client, session } = clientFor(desktop)
    const err = await caught(client.pair('000000'))
    expect(err).toBeInstanceOf(RemoteInvalidCodeError)
    expect((err as RemoteInvalidCodeError).userMessage).toMatch(/code is not correct/i)
    expect(session.token).toBe('')
  })

  it('schickt einen Code, der nie stimmen kann, gar nicht erst los', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    expect(await caught(client.pair('12345'))).toBeInstanceOf(RemoteInvalidCodeError)
    expect(await caught(client.pair('abcdef'))).toBeInstanceOf(RemoteInvalidCodeError)
    expect(desktop.log.filter((l) => l.includes('/remote-api/auth'))).toEqual([])
  })

  it('wird nach drei falschen Codes gesperrt und nennt die Wartezeit, auch fuer den richtigen Code', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    for (let i = 0; i < 3; i++) expect(await caught(client.pair('000000'))).toBeInstanceOf(RemoteInvalidCodeError)

    const locked = await caught(client.pair('123456'))
    expect(locked).toBeInstanceOf(RemoteRateLimitedError)
    expect((locked as RemoteRateLimitedError).retryAfterSeconds).toBe(60)
    expect((locked as RemoteRateLimitedError).userMessage).toBe('Too many wrong codes. Try again in 60 seconds.')

    desktop.advance(61)
    await expect(client.pair('123456')).resolves.toBeTruthy()
  })

  it('lehnt den alten Code ab, wenn er am Desktop abgelaufen ist', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    desktop.advance(901)
    expect(await caught(client.pair('123456'))).toBeInstanceOf(RemoteInvalidCodeError)
    await expect(client.pair(desktop.passcode)).resolves.toBeTruthy()
  })

  it('erkennt einen fremden Server an der Adresse', async () => {
    desktop = await startFakeDesktop()
    const foreign: RemoteFetch = async () => new Response('<html>router login</html>', { status: 200 })
    const { client } = clientFor(desktop, { fetch: foreign })
    expect(await caught(client.probe())).toBeInstanceOf(RemoteNotLuError)
  })
})

describe('Sitzung', () => {
  it('meldet ein fehlendes Token ohne Netzaufruf', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    const err = await caught(client.listModels())
    expect(err).toBeInstanceOf(RemoteSessionExpiredError)
    expect((err as RemoteSessionExpiredError).reason).toBe('missing')
    expect(desktop.log).toEqual([])
  })

  it('meldet ein abgelaufenes Token als RemoteSessionExpiredError', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    desktop.advance(JWT_TTL_SECS + 1)
    const err = await caught(client.checkSession())
    expect(err).toBeInstanceOf(RemoteSessionExpiredError)
    expect((err as RemoteSessionExpiredError).reason).toBe('expired')
    expect((err as RemoteSessionExpiredError).userMessage).toMatch(/pair again/i)
  })

  it('uebernimmt das verlaengerte Token aus der Kopfzeile, sobald die Haelfte der Zeit um ist', async () => {
    desktop = await startFakeDesktop()
    const { client, session } = clientFor(desktop)
    const first = await client.pair('123456')

    desktop.advance(10 * 60)
    await client.checkSession()
    expect(session.token).toBe(first)

    desktop.advance(25 * 60)
    await client.checkSession()
    expect(session.token).not.toBe(first)
    expect(session.seen).toHaveLength(2)

    // Mit dem neuen Token lebt die Sitzung ueber die erste Stunde hinaus.
    desktop.advance(40 * 60)
    await expect(client.checkSession()).resolves.toMatchObject({ app: 'LU' })
  })

  it('haelt eine benutzte Sitzung nicht ueber die 24-Stunden-Grenze hinaus am Leben', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    for (let t = 0; t < MAX_SESSION_SECS + JWT_TTL_SECS; t += 20 * 60) {
      desktop.advance(20 * 60)
      try {
        await client.checkSession()
      } catch (err) {
        expect(err).toBeInstanceOf(RemoteSessionExpiredError)
        expect(t).toBeGreaterThanOrEqual(MAX_SESSION_SECS - 20 * 60)
        return
      }
    }
    throw new Error('session never ended')
  })

  it('unterscheidet "am Desktop getrennt" von "abgelaufen"', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    desktop.dropAllDevices()
    const err = await caught(client.listModels())
    expect(err).toBeInstanceOf(RemoteSessionExpiredError)
    expect((err as RemoteSessionExpiredError).reason).toBe('ended')
    // A17: genau dieser 401 nennt den Browser auf demselben Handy (Desktop 3.0.7 wirft die App dann hinaus).
    expect((err as RemoteSessionExpiredError).userMessage).toContain('open in the browser of this phone')
    expect(new RemoteSessionExpiredError('expired').userMessage).not.toContain('browser')
  })

  it('verliert die Sitzung, wenn Remote Access am Desktop neu gestartet wurde', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    desktop.restart('654321')
    expect(await caught(client.checkSession())).toBeInstanceOf(RemoteSessionExpiredError)
    await expect(client.pair('654321')).resolves.toBeTruthy()
  })

  it('beendet die eigene Sitzung am Desktop', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    expect((await client.getOwnDevice())?.id).toBe(desktop.devices[0].id)
    await client.disconnect()
    expect(desktop.devices).toEqual([])
    expect(await caught(client.checkSession())).toBeInstanceOf(RemoteSessionExpiredError)
  })

  it('meldet die Sperre nach geaenderten Erinnerungen als eigenen Fehler', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    desktop.revokeMemory()
    expect(await caught(client.listModels())).toBeInstanceOf(RemoteMemoryRevokedError)
    expect(await caught(client.streamChat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] }))).toBeInstanceOf(
      RemoteMemoryRevokedError,
    )
    // Die oeffentliche Pruefung bleibt offen: der Desktop ist da, nur gesperrt.
    await expect(client.probe()).resolves.toMatchObject({ status: 'ok' })
  })

  it('erkennt die Sperre auch ueber einen Transport, der Kopfzeilen verliert', async () => {
    desktop = await startFakeDesktop()
    const headerless: RemoteFetch = async (url, init) => {
      const r = await fetch(url, init)
      return new Response(await r.text(), { status: r.status })
    }
    const { client } = clientFor(desktop, { fetch: headerless })
    await client.pair('123456')
    desktop.revokeMemory()
    expect(await caught(client.listModels())).toBeInstanceOf(RemoteMemoryRevokedError)
  })
})

describe('Chat', () => {
  const ask = [{ role: 'user' as const, content: 'hi' }]

  it('liefert die Antwort des Desktops, der sie am Stueck schickt', async () => {
    desktop = await startFakeDesktop({ reply: 'One two three.' })
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const updates: string[] = []
    const result = await client.streamChat({
      model: 'qwen3:8b',
      messages: ask,
      think: false,
      onUpdate: (p) => updates.push(p.content),
    })
    expect(result).toEqual({ content: 'One two three.', thinking: '', completed: true, stopReason: 'done' })
    expect(updates.at(-1)).toBe('One two three.')
    expect(desktop.chatRequests[0].body).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: false,
      options: { num_predict: 16384 },
      messages: ask,
    })
  })

  it('zeigt Zwischenstaende, wenn der Desktop wirklich streamt', async () => {
    desktop = await startFakeDesktop({ reply: 'One two three four.', delivery: 'chunked', delayMs: 5 })
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const updates: string[] = []
    const result = await client.streamChat({ model: 'qwen3:8b', messages: ask, onUpdate: (p) => updates.push(p.content) })
    expect(result.content).toBe('One two three four.')
    expect(updates.length).toBeGreaterThan(2)
    expect(updates[0]).toBe('One ')
  })

  it('bricht mitten im Stream ab, behaelt den Teilstand, und der Desktop sieht die Verbindung enden', async () => {
    desktop = await startFakeDesktop({ reply: 'a b c d e f g h i j k l m n o p', delivery: 'chunked', delayMs: 15 })
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const ctrl = new AbortController()
    let last = ''
    const result = await client.streamChat({
      model: 'qwen3:8b',
      messages: ask,
      signal: ctrl.signal,
      onUpdate: (p) => {
        last = p.content
        if (p.content.length >= 6) ctrl.abort()
      },
    })
    expect(result.completed).toBe(false)
    expect(result.stopReason).toBe('aborted')
    expect(result.content.length).toBeGreaterThanOrEqual(6)
    expect(result.content.length).toBeLessThan('a b c d e f g h i j k l m n o p'.length)
    expect(result.content).toBe(last)
    await expect.poll(() => desktop!.chatRequests[0].clientGone).toBe(true)
  })

  it('bricht ab, waehrend der Desktop noch sammelt: kein Teilstand, aber ein sauberes Ende', async () => {
    desktop = await startFakeDesktop({ delayMs: 2_000 })
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 40)
    const started = Date.now()
    const result = await client.streamChat({ model: 'qwen3:8b', messages: ask, signal: ctrl.signal })
    expect(result).toEqual({ content: '', thinking: '', completed: false, stopReason: 'aborted' })
    expect(Date.now() - started).toBeLessThan(1_000)
    await expect.poll(() => desktop!.chatRequests[0].clientGone).toBe(true)
  })

  it('gibt den Teilstand mit, wenn die Verbindung mitten in der Antwort reisst', async () => {
    desktop = await startFakeDesktop({ reply: 'one two three four five', delivery: 'chunked', delayMs: 5 })
    desktop.killStreamAfterLines = 2
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const err = await caught(client.streamChat({ model: 'qwen3:8b', messages: ask }))
    expect(err).toBeInstanceOf(RemoteConnectionLostError)
    expect((err as RemoteConnectionLostError).partial.content).toBe('one two ')
    expect((err as RemoteConnectionLostError).userMessage).toMatch(/saved/i)
  })

  it('meldet einen verschwundenen Server als nicht erreichbar', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    await desktop.stop()
    const err = await caught(client.streamChat({ model: 'qwen3:8b', messages: ask }))
    expect(err).toBeInstanceOf(RemoteUnreachableError)
    expect((err as RemoteUnreachableError).userMessage).toMatch(/same Wi-Fi/)
    expect(await caught(client.probe())).toBeInstanceOf(RemoteUnreachableError)
  })

  it('meldet ein abgelaufenes Token beim Senden, nicht eine leere Antwort', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    desktop.advance(JWT_TTL_SECS + 1)
    expect(await caught(client.streamChat({ model: 'qwen3:8b', messages: ask }))).toBeInstanceOf(RemoteSessionExpiredError)
  })

  it('versucht es einmal ohne think, wenn das Backend das Feld ablehnt', async () => {
    desktop = await startFakeDesktop({ reply: 'ok' })
    desktop.rejectThink = true
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const result = await client.streamChat({ model: 'qwen3:8b', messages: ask, think: false })
    expect(result.content).toBe('ok')
    expect(desktop.chatRequests.map((r) => 'think' in r.body)).toEqual([true, false])
  })

  it('meldet ein totes Modell-Backend und ein unbekanntes Modell als Backend-Fehler', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const missing = await caught(client.streamChat({ model: 'nope:1b', messages: ask }))
    expect(missing).toBeInstanceOf(RemoteBackendError)
    expect((missing as RemoteBackendError).status).toBe(404)

    desktop.backendDown = true
    const down = await caught(client.streamChat({ model: 'qwen3:8b', messages: ask }))
    expect(down).toBeInstanceOf(RemoteBackendError)
    expect((down as RemoteBackendError).userMessage).toMatch(/model backend/)
  })

  it('liest die Antworten eines Tunnels richtig: 524 ist eine Frist, 530 ein toter Link', async () => {
    const answer = (status: number, body: string): RemoteFetch => async () => new Response(body, { status })
    const tunnel = (f: RemoteFetch) =>
      createRemoteClient({ baseUrl: 'https://quiet-river-12.trycloudflare.com', fetch: f, getToken: () => 't' })

    const slow = await caught(tunnel(answer(524, '<html>cloudflare: a timeout occurred</html>')).streamChat({ model: 'm', messages: ask }))
    expect(slow).toBeInstanceOf(RemoteTimeoutError)

    const dead = await caught(tunnel(answer(530, '<html>Cloudflare Tunnel error</html>')).listModels())
    expect(dead).toBeInstanceOf(RemoteUnreachableError)
    expect((dead as RemoteUnreachableError).userMessage).toMatch(/scan the new QR code/)
    expect(await caught(tunnel(answer(530, '<html>Cloudflare Tunnel error</html>')).probe())).toBeInstanceOf(RemoteUnreachableError)
  })

  it('bricht nach der Frist ab, wenn der Desktop schweigt', async () => {
    desktop = await startFakeDesktop({ delayMs: 2_000 })
    const { client } = clientFor(desktop, { timeouts: { chatMs: 60 } })
    await client.pair('123456')
    expect(await caught(client.streamChat({ model: 'qwen3:8b', messages: ask }))).toBeInstanceOf(RemoteTimeoutError)
  })
})

describe('Agent-Bausteine', () => {
  it('holt Werkzeugaufrufe ohne Stream und fuehrt ein Werkzeug am Desktop aus', async () => {
    desktop = await startFakeDesktop()
    desktop.nextToolCalls = [{ function: { name: 'get_current_time', arguments: {} } }]
    const { client } = clientFor(desktop)
    await client.pair('123456')

    const turn = await client.chatWithTools({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'time?' }], tools: [{ type: 'function' }] })
    expect(turn.toolCalls).toEqual([{ function: { name: 'get_current_time', arguments: {} } }])
    expect(desktop.chatRequests[0].body).toMatchObject({ stream: false, tools: [{ type: 'function' }] })

    const ok = await client.runAgentTool({ tool: 'get_current_time', chatId: 'c-1' })
    expect(ok).toEqual({ ok: true, data: { time: '2026-10-08T12:00:00Z' } })
    expect(desktop.toolCalls[0]).toEqual({ tool: 'get_current_time', args: {}, chatId: 'c-1' })
  })

  it('gibt eine fehlende Freigabe als Ergebnis zurueck, nicht als Wurf', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const denied = await client.runAgentTool({ tool: 'file_read', args: { path: 'a.txt' } })
    expect(denied.ok).toBe(false)
    expect(denied.needsPermission).toBe('filesystem')

    desktop.permissions.filesystem = true
    expect(await client.runAgentTool({ tool: 'file_read', args: { path: 'a.txt' } })).toEqual({ ok: true, data: { content: 'file body' } })

    const unknown = await client.runAgentTool({ tool: 'format_disk' })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/not available to remote clients/)
  })

  it('erkennt ein Modell ohne Werkzeuge', async () => {
    desktop = await startFakeDesktop({ models: ['notools:1b'] })
    const { client } = clientFor(desktop)
    await client.pair('123456')
    const err = await caught(client.chatWithTools({ model: 'notools:1b', messages: [], tools: [{}] }))
    expect(isToolsUnsupported(err)).toBe(true)
  })

  it('spiegelt Nachrichten an den Desktop und wirft dabei nie', async () => {
    desktop = await startFakeDesktop()
    const { client } = clientFor(desktop)
    await client.pair('123456')
    expect(await client.postChatEvent({ role: 'user', content: 'hi', chatId: 'c-1', chatTitle: 'T', model: 'qwen3:8b' })).toBe(true)
    expect(desktop.chatEvents).toEqual([{ role: 'user', content: 'hi', model: 'qwen3:8b', mode: 'lu', chat_id: 'c-1', chat_title: 'T' }])
    expect(await client.postChatEvent({ role: 'assistant', content: 'x'.repeat(100 * 1024 + 1), chatId: 'c-1' })).toBe(false)
    expect(desktop.chatEvents).toHaveLength(1)
    await desktop.stop()
    expect(await client.postChatEvent({ role: 'user', content: 'hi', chatId: 'c-1' })).toBe(false)
  })

  it('meldet HTML statt JSON als Protokollfehler', async () => {
    desktop = await startFakeDesktop()
    const html: RemoteFetch = async () => new Response('<!doctype html>', { status: 200 })
    const session = { token: 't' }
    const client = createRemoteClient({ baseUrl: desktop.url, fetch: html, getToken: () => session.token })
    expect(await caught(client.getConfig())).toBeInstanceOf(RemoteProtocolError)
  })
})

describe('Stream-Parser', () => {
  it('setzt Zeilen ueber Stueckgrenzen hinweg zusammen', () => {
    const p = createChatStreamParser(false)
    expect(p.push('{"message":{"content":"Hel')).toBe(false)
    expect(p.push('lo"},"done":false}\n{"message":{"content":" you"}')).toBe(true)
    expect(p.content).toBe('Hello')
    p.push(',"done":false}\n{"message":{"content":""},"done":true}')
    expect(p.done).toBe(false)
    p.end()
    expect(p.content).toBe('Hello you')
    expect(p.done).toBe(true)
  })

  it('verwirft Denktext, wenn er nicht gewuenscht ist, auch ueber Stueckgrenzen', () => {
    const p = createChatStreamParser(false)
    p.push('{"message":{"content":"<thi"}}\n{"message":{"content":"nk>secret plan</th"}}\n')
    p.push('{"message":{"content":"ink>Answer","thinking":"native"}}\n')
    expect(p.content).toBe('Answer')
    expect(p.thinking).toBe('')
  })

  it('behaelt Denktext getrennt, wenn er gewuenscht ist', () => {
    const p = createChatStreamParser(true)
    p.push('{"message":{"thinking":"native. "}}\n{"message":{"content":"<think>inline</think>Answer"}}\n')
    expect(p.content).toBe('Answer')
    expect(p.thinking).toBe('native. inline')
  })

  it('haelt einen nie geschlossenen Gedankenblock bis zum Ende verborgen', () => {
    const p = createChatStreamParser(false)
    p.push('{"message":{"content":"Hi <thought>plan"}}\n{"message":{"content":" more plan"}}\n')
    expect(p.content).toBe('Hi ')
    p.push('{"message":{"content":"</thought>Answer"}}\n')
    expect(p.content).toBe('Hi Answer')
  })

  it('merkt sich eine Fehlerzeile des Backends', () => {
    const p = createChatStreamParser(false)
    p.push('{"error":"out of memory"}\n')
    expect(p.error).toBe('out of memory')
  })
})

describe('Kleinteile', () => {
  it('liest die Wartezeit aus dem Text des Desktops', () => {
    expect(parseRetryAfterSeconds('Too many attempts. Try again in 42s')).toBe(42)
    expect(parseRetryAfterSeconds('')).toBe(60)
  })

  it('setzt den think-Schalter dreiwertig wie die Handy-Seite', () => {
    expect(resolveThinkFlag('llama3.1:8b', true)).toBeUndefined()
    expect(resolveThinkFlag('qwen3:8b', true)).toBe(true)
    expect(resolveThinkFlag('qwen3:8b', false)).toBe(false)
    expect(resolveThinkFlag('gemma4:e4b', false)).toBeUndefined()
    expect(resolveThinkFlag('gemma4:e4b', true)).toBe(true)
  })

  it('schreibt keine Gedankenstriche in Nutzertexte', async () => {
    const errors = await import('../remoteErrors')
    const samples = [
      new errors.RemoteInvalidAddressError(),
      new errors.RemoteUnreachableError(false),
      new errors.RemoteUnreachableError(true),
      new errors.RemoteTimeoutError(),
      new errors.RemoteNotLuError(),
      new errors.RemoteInvalidCodeError(),
      new errors.RemoteRateLimitedError(1),
      new errors.RemoteSessionExpiredError('expired'),
      new errors.RemoteSessionExpiredError('ended'),
      new errors.RemoteMemoryRevokedError(),
      new errors.RemotePermissionError('shell'),
      new errors.RemoteBackendError(502),
      new errors.RemoteBackendError(500),
      new errors.RemoteConnectionLostError({ content: '', thinking: '' }),
      new errors.RemoteProtocolError(),
    ]
    for (const e of samples) {
      expect(e.userMessage, e.code).not.toMatch(/[\u2012-\u2015]| - /)
      expect(e.userMessage.endsWith('.'), e.code).toBe(true)
      expect(e.message).toBe(e.userMessage)
    }
    expect(new errors.RemoteRateLimitedError(1).userMessage).toBe('Too many wrong codes. Try again in 1 second.')
  })
})
