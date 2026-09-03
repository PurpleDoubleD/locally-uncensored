import { describe, it, expect } from 'vitest'
import {
  detectChatToolCapability,
  detectChatToolIntent,
  isMediaContinuation,
  resolveChatToolRoute,
  CHAT_TOOLS,
  type ChatToolRouteMsg,
} from '../chat-tool-intent'

describe('detectChatToolCapability', () => {
  it('exposes exactly the five curated tools', () => {
    expect([...CHAT_TOOLS].sort()).toEqual(
      ['file_write', 'image_generate', 'video_generate', 'web_fetch', 'web_search'].sort(),
    )
  })

  describe('image', () => {
    for (const p of [
      'draw me a picture of a red apple',
      'generate an image of a sunset over mountains',
      'make a logo for my coffee shop',
      'mal mir ein bild von einem hund',
      'erstelle eine grafik mit einem berg',
      'zeichne ein porträt einer katze',
    ]) {
      it(`image: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('image'))
    }
  })

  describe('video', () => {
    for (const p of [
      'make a short video of waves at the beach',
      'generate a clip of a flying bird',
      'animate this image into a video',
      'erstelle ein video von einem wasserfall',
      'animier das bild',
    ]) {
      it(`video: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('video'))
    }

    it('prefers video when both a video and image noun appear', () => {
      expect(detectChatToolCapability('turn this picture into a short video')).toBe('video')
    })

    it('routes "animate" with an attached image to video', () => {
      expect(detectChatToolCapability('animate this', true)).toBe('video')
    })
  })

  describe('web', () => {
    for (const p of [
      'search the web for the latest python version',
      'google who won the champions league final',
      'look up the current bitcoin price',
      'what is the weather in Berlin right now',
      'such im web nach den neuesten nvidia treibern',
      'recherchiere die aktuellen news zu KI',
      'summarize this page https://example.com/post',
      'open https://news.ycombinator.com and tell me the top story',
    ]) {
      it(`web: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('web'))
    }
  })

  describe('file', () => {
    for (const p of [
      'write a file called notes.txt with my todo list',
      'save this to a file',
      'create a hello.html with a heading',
      'schreib eine datei mit dem text hallo',
      'speicher das als output.json',
      'export the result to a csv file',
    ]) {
      it(`file: "${p}"`, () => expect(detectChatToolCapability(p)).toBe('file'))
    }
  })

  describe('plain conversation must NOT route (no false positives)', () => {
    for (const p of [
      'hi there',
      'how are you today?',
      'explain how recursion works',
      'what is the capital of France',
      'tell me a joke',
      'can you help me understand quantum entanglement',
      'i like the picture you described earlier', // mentions "picture" but no create verb
      'thanks, that was helpful',
      'write a haiku about autumn', // "write" but no file noun/extension
      'make it shorter please',
      'what do you think about this idea',
      'summarize the conversation so far', // no page/url noun
    ]) {
      it(`plain: "${p}"`, () => expect(detectChatToolCapability(p)).toBeNull())
    }
  })

  it('detectChatToolIntent is the boolean wrapper', () => {
    expect(detectChatToolIntent('draw a cat')).toBe(true)
    expect(detectChatToolIntent('hello')).toBe(false)
    expect(detectChatToolIntent('')).toBe(false)
  })
})

// David 2026-06-20 — the real "football" chat: every media FOLLOW-UP missed the
// single-message detector and dropped to plain chat, so the model planned in
// circles or faked "(generating…)" and produced nothing.
describe('isMediaContinuation', () => {
  for (const p of [
    'ok go', 'go', 'do it', 'yes', 'jetzt', 'los',
    '2 seconds just zoom in', '2 seconds', '3s',
    'nochmal neu', 'noch mal', 'neu', 'again', 'regenerate', 'redo',
    'geberuere das video neu', // typo'd "generiere" — caught via "neu"
    'ok generiere jetzt', 'du generierst nix.',
    'make it longer', 'spin it', 'länger bitte',
  ]) {
    it(`continuation: "${p}"`, () => expect(isMediaContinuation(p)).toBe(true))
  }
  for (const p of [
    'thanks', 'thank you', 'danke', 'perfekt', 'cool', 'nice', 'super',
    'danke das war super', 'stop', 'cancel',
    'now tell me about cats', // "now" but too long → not a bare continuation
    'what is the capital of France', 'tell me a joke', 'explain recursion',
  ]) {
    it(`not a continuation: "${p}"`, () => expect(isMediaContinuation(p)).toBe(false))
  }
})

describe('resolveChatToolRoute — context-aware media continuation', () => {
  const videoBlock: ChatToolRouteMsg = {
    role: 'assistant', content: 'Here is your clip',
    mediaKind: 'video', mediaArgs: { prompt: 'a football, zoom in', inputImage: 'football.png', duration: 2 },
  }

  it('a direct verb+noun request still routes', () => {
    expect(resolveChatToolRoute('generate an image of a football', false, [])?.capability).toBe('image')
    expect(resolveChatToolRoute('make a short video of waves', false, [])?.capability).toBe('video')
  })

  it('a bare "ok generiere jetzt" reuses the prior video block ARGS (faithful regenerate)', () => {
    const recent: ChatToolRouteMsg[] = [
      { role: 'user', content: 'now make a video out of that image' },
      videoBlock,
      { role: 'user', content: 'nochmal neu' },
      { role: 'assistant', content: '(Generating the video…)' }, // the fake-gen turn, no block
    ]
    const r = resolveChatToolRoute('ok generiere jetzt', false, recent)
    expect(r?.capability).toBe('video')
    expect(r?.mediaHint?.kind).toBe('video')
    expect(r?.mediaHint?.args).toEqual({ prompt: 'a football, zoom in', inputImage: 'football.png', duration: 2 })
  })

  it('a continuation infers the kind from an earlier user request when no block exists yet', () => {
    const recent: ChatToolRouteMsg[] = [
      { role: 'user', content: 'now make a video out of that image' },
      { role: 'assistant', content: 'How long should it be, and what motion?' },
    ]
    const r = resolveChatToolRoute('2 seconds just zoom in', false, recent)
    expect(r?.capability).toBe('video')
    expect(r?.mediaHint?.kind).toBe('video')
  })

  it('does NOT route a bare continuation with no recent media context', () => {
    const recent: ChatToolRouteMsg[] = [
      { role: 'user', content: 'explain recursion' },
      { role: 'assistant', content: 'Recursion is when a function calls itself…' },
    ]
    expect(resolveChatToolRoute('ok go', false, recent)).toBeNull()
  })

  it('praise after a media turn does NOT re-trigger the tool', () => {
    expect(resolveChatToolRoute('perfekt danke', false, [videoBlock])).toBeNull()
  })

  it('a NEW explicit web request after media routes to web, not the sticky media', () => {
    expect(
      resolveChatToolRoute('search the web for the weather in Berlin', false, [videoBlock])?.capability,
    ).toBe('web')
  })

  it('only looks back a bounded window (stale media far in the past is ignored)', () => {
    const recent: ChatToolRouteMsg[] = [
      videoBlock, // oldest
      ...Array.from({ length: 14 }, (_, i): ChatToolRouteMsg => ({ role: i % 2 ? 'assistant' : 'user', content: `chit chat ${i}` })),
    ]
    expect(resolveChatToolRoute('ok go', false, recent)).toBeNull()
  })
})

// ── Deutsch bekommt dieselben Werkzeuge wie Englisch (Persona B3) ────────

describe('die Erkennung darf nicht an der Sprache haengen', () => {
  /**
   * Persona-Lauf vom 03.09.2026, `llama3.2:3b`, normaler Chat. Zweimal in
   * frischen Chats getippt:
   *
   *   „Hol bitte die Seite https://example.com und sag mir woertlich,
   *    welche Ueberschrift dort steht."
   *
   * Im Netzwerk-Payload an Ollama stand **kein `tools`-Feld**. Das Modell
   * antwortete, es koenne keine URLs aufrufen. Dieselbe Bitte auf Englisch,
   * gleicher Chat, gleiches Modell: `tools: [web_search, web_fetch,
   * file_write]` und eine korrekte Antwort. Die Plugins-Leiste sagte dabei
   * die ganze Zeit „Chat Tools · web · file · image · video" — die App
   * behauptete also, die Werkzeuge seien an.
   *
   * Zwei Luecken steckten darin:
   *
   * 1. „hol" fehlte in der deutschen Verbliste. Sie kannte oeffne/lies/
   *    fasse/ruf…auf — aber nicht das Verb, das man am ehesten tippt.
   * 2. Die Persona schreibt „woertlich" und „Ueberschrift", also deutsches
   *    Umlaut-freies Tippen. Ein Muster, das auf „öffne" besteht, verfehlt
   *    „oeffne" — und wer keine Umlaute tippt, tippt sie nirgends.
   */
  const persona = 'Hol bitte die Seite https://example.com und sag mir woertlich, welche Ueberschrift dort steht.'

  it('erkennt den Satz der Persona', () => {
    expect(detectChatToolCapability(persona)).toBe('web')
  })

  it('erkennt dieselbe Bitte mit den ueblichen deutschen Verben', () => {
    for (const satz of [
      'Hole bitte die Seite https://example.com',
      'Oeffne die Seite https://example.com',
      'Öffne die Seite https://example.com',
      'Ruf die Webseite example.com auf',
      'Zeig mir bitte die Seite https://example.com',
      'Lade die Seite https://example.com und fasse sie zusammen',
      'Schau dir bitte den Artikel auf example.com an',
      'Besuche die Webseite example.com',
    ]) {
      expect(detectChatToolCapability(satz), satz).toBe('web')
    }
  })

  it('umlautfrei getipptes Deutsch zaehlt ueberall gleich', () => {
    // Nicht nur beim Abrufen: wer keine Umlaute tippt, tippt auch beim Bild
    // und beim Video keine.
    expect(detectChatToolCapability('Male mir ein Gemaelde von einer Katze')).toBe('image')
    expect(detectChatToolCapability('Male mir ein Gemälde von einer Katze')).toBe('image')
    expect(detectChatToolCapability('Erstelle ein Portraet von einem Hund')).toBe('image')
    expect(isMediaContinuation('laenger bitte')).toBe(true)
    expect(isMediaContinuation('länger bitte')).toBe(true)
    expect(isMediaContinuation('tschuess')).toBe(false)
  })

  it('gewoehnliche Unterhaltung bleibt auf dem schnellen Weg', () => {
    // Der Preis eines Fehlalarms ist echt: der Zug laeuft dann durch den
    // Werkzeug-Ausfuehrer, und genau daran verschluckt sich ein 3B-Modell.
    for (const satz of [
      'Wie geht es dir heute?',
      'Erklaer mir mal, wie Rekursion funktioniert',
      'Ich habe auf https://example.com gelesen, dass Katzen viel schlafen',
      'Danke, das war hilfreich',
      'Was haeltst du von dieser Idee?',
    ]) {
      expect(detectChatToolCapability(satz), satz).toBeNull()
    }
  })
})
