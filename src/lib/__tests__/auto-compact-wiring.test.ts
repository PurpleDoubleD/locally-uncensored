/**
 * Auto-Compact: das Opt-in und die Verdrahtung (2.6.8, Compact-Schritt 4).
 *
 * Zwei Zusicherungen, die einzeln wenig und zusammen alles wert sind.
 *
 * Die erste ist eine Negativ-Aussage. Mit den ausgelieferten Einstellungen
 * darf `maybeAutoCompact` NICHTS tun — nicht den Gespraechs-Store lesen, nicht
 * das Fenster aufloesen, erst recht kein Modell fragen. Die Entscheidung vom
 * 02.09.2026 war "einstellbar sonst aus", und der Grund steht in
 * compact-trigger.ts: eine Zusammenfassung ersetzt Gespraechsverlauf, und wenn
 * sie falsch ist, verliert der Nutzer Arbeit, ohne es zu merken. Ein gespei-
 * chertes Profil auf STORE_VERSION 21 liefert das Feld als `undefined` aus
 * (der additive Merge fuellt es erst beim naechsten Versionssprung nach) —
 * wuerde das als Zahl durchgehen, waere das Feature bei jedem Bestandsnutzer
 * ungefragt an.
 *
 * Die zweite ist die Verdrahtung, und sie ist der eigentliche Wert dieser
 * Datei. Die Funktion taugt nur so viel, wie es Sende-Pfade gibt, die sie
 * aufrufen. Ein Hook, der sie vergisst, verliert das Feature auf einer ganzen
 * Oberflaeche — nichts bricht, nichts wirft, die Chats werden nur wieder
 * vollstaendig verschickt. Dasselbe gilt fuer die Nutz-Seite: wer eine
 * Compaction aufzeichnet, sie aber beim Bauen der Anfrage nicht anwendet,
 * bezahlt die Zusammenfassung und schickt trotzdem die ganze Historie.
 * Deshalb wird die Liste der Sende-Hooks aus dem Quellverzeichnis abgeleitet
 * und nicht hier hingeschrieben.
 *
 * Lauf: npx vitest run src/lib/__tests__/auto-compact-wiring.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// resolveAgentNumCtx ist der Netz-Rand dieses Pfades: es fragt Ollama bzw. den
// Modellkatalog nach dem echten Fenster. Ersetzt, weil "wurde es ueberhaupt
// gefragt?" GENAU die Aussage ist, um die es in dieser Datei geht — anders ist
// ein nicht erfolgter Aufruf nicht beobachtbar — und weil sonst jeder Lauf an
// einem laufenden Backend haengen wuerde. Das Modul unter Test bleibt echt.
vi.mock('../agent-num-ctx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-num-ctx')>()
  // Seit 2026-09-02 fragt der Auto-Ausloeser die Fassung MIT Vertrauensangabe
  // — er braucht die Auskunft "gemessen oder geraten", die eine blosse Zahl
  // nicht geben kann. Beide werden ersetzt, damit diese Datei weiterhin
  // beobachtet, OB gefragt wurde, egal auf welchem der beiden Wege.
  return {
    ...actual,
    resolveAgentNumCtx: vi.fn(async () => 32768),
    resolveAgentNumCtxWithConfidence: vi.fn(async () => ({ ctx: 32768, gemessen: true })),
  }
})

// Der Zusammenfasser ist der Modell-Rand dieses Pfades. Ersetzt, weil dieser
// Abschnitt genau den Fall braucht, den ein echtes Modell nicht auf Bestellung
// liefert: einen FEHLGESCHLAGENEN Lauf.
vi.mock('../compact-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compact-run')>()
  return { ...actual, runCompactSummary: vi.fn(actual.runCompactSummary) }
})

import { maybeAutoCompact, runCompactForConversation } from '../run-compact-command'
import { runCompactSummary } from '../compact-run'
import { resolveAgentNumCtxWithConfidence } from '../agent-num-ctx'
import { usableThreshold, MIN_MESSAGES_TO_COMPACT, MIN_MESSAGES_SINCE_COMPACT } from '../compact-trigger'
import { DEFAULT_SETTINGS } from '../constants'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { Settings } from '../../types/settings'

const fensterAufloesen = vi.mocked(resolveAgentNumCtxWithConfidence)

const here = dirname(fileURLToPath(import.meta.url))
const hooksDir = resolve(here, '../../hooks')
const lies = (datei: string) => readFileSync(resolve(hooksDir, datei), 'utf8')

const MODELL = 'llama3:8b'

/** Ein Gespraech, das lang genug ist, dass die Kuerze kein Ausgang mehr ist. */
function seedGespraech(anzahl = MIN_MESSAGES_TO_COMPACT + 4): string {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  const id = useChatStore.getState().createConversation(MODELL, '')
  for (let i = 0; i < anzahl; i++) {
    useChatStore.getState().addMessage(id, {
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Nachricht ${i}`,
      timestamp: i,
    })
  }
  return id
}

/** Einstellungen wie ausgeliefert, mit genau einer geaenderten Schwelle. */
function setzeSchwelle(schwelle: number) {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, autoCompactThreshold: schwelle },
  })
}

/** Ein Profil aus der Zeit vor dem Feld: der Schluessel fehlt ganz. */
function setzeProfilOhneFeld() {
  const ohne: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  delete ohne.autoCompactThreshold
  useSettingsStore.setState({ settings: ohne as unknown as Settings })
}

/**
 * Zaehlt Zugriffe auf den Gespraechs-Store. Erst NACH dem Seeden anhaengen,
 * sonst zaehlt das Aufbauen des Falls als Zugriff der Funktion.
 */
function beobachteStore() {
  return vi.spyOn(useChatStore, 'getState')
}

describe('Opt-in: mit den ausgelieferten Einstellungen passiert nichts', () => {
  beforeEach(() => {
    fensterAufloesen.mockClear()
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('die ausgelieferte Schwelle ist 0 und liest sich als "aus"', () => {
    expect(DEFAULT_SETTINGS.autoCompactThreshold).toBe(0)
    expect(DEFAULT_SETTINGS.autoCompactThreshold).toBeFalsy()
    // Dieselbe 0 muss auch der Entscheider als "nie" lesen, sonst haengt das
    // Aus-Sein an zwei Stellen, die auseinanderlaufen koennen.
    expect(usableThreshold(DEFAULT_SETTINGS.autoCompactThreshold)).toBeNull()
  })

  it('mit den ausgelieferten Einstellungen liefert maybeAutoCompact null', async () => {
    const convId = seedGespraech()
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS })
    expect(await maybeAutoCompact({ conversationId: convId, activeModel: MODELL })).toBeNull()
  })

  it('ein gespeichertes Profil ohne das Feld ist aus, nicht 0.3', async () => {
    // STORE_VERSION 21 hat fuer diesen Schluessel keinen Sprung bekommen, das
    // Feld kommt also bei Bestandsnutzern als undefined an. Ein Default, der
    // sich hier einschliche, waere das Feature bei allen von ihnen an.
    const convId = seedGespraech()
    setzeProfilOhneFeld()
    expect(useSettingsStore.getState().settings.autoCompactThreshold).toBeUndefined()
    expect(await maybeAutoCompact({ conversationId: convId, activeModel: MODELL })).toBeNull()
  })

  it('auch eine Schwelle ausserhalb des erlaubten Bereichs bleibt aus', async () => {
    const convId = seedGespraech()
    // 0.2 liegt unter MIN_THRESHOLD. Die Zahl ist wahr, aber unbrauchbar —
    // die UI darf sie nicht liefern, und wenn doch, entscheidet der Trigger.
    setzeSchwelle(0.2)
    expect(await maybeAutoCompact({ conversationId: convId, activeModel: MODELL })).toBeNull()
  })
})

describe('Reihenfolge: das Billige zuerst, denn das laeuft bei jedem Senden', () => {
  beforeEach(() => {
    fensterAufloesen.mockClear()
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ohne Schwelle wird weder der Store gelesen noch das Fenster aufgeloest', async () => {
    // Das ist die Eigenschaft, die das Feature bezahlbar macht: dieser Aufruf
    // steht in jedem Sende-Pfad und muss ohne Opt-in ein Vergleich sein und
    // sonst nichts. Ein Store-Lesen waere noch billig, das Fenster-Aufloesen
    // ist ein Netzweg zum Backend — auf jeder Nachricht, fuer nichts.
    const convId = seedGespraech()
    const store = beobachteStore()

    expect(await maybeAutoCompact({ conversationId: convId, activeModel: MODELL })).toBeNull()

    expect(store).not.toHaveBeenCalled()
    expect(fensterAufloesen).not.toHaveBeenCalled()
  })

  it('mit Schwelle werden beide sehr wohl gefragt — sonst hiesse die Prüfung nichts', async () => {
    // Gegenprobe zur vorigen: ohne sie koennte maybeAutoCompact schlicht immer
    // frueh aussteigen und beide Zusicherungen waeren erfuellt.
    const convId = seedGespraech()
    setzeSchwelle(0.8)
    const store = beobachteStore()

    // Kurze Nachrichten gegen ein 32k-Fenster: der Trigger sagt "below" und
    // es kommt null zurueck, ohne dass ein Modell etwas schreiben muesste.
    expect(await maybeAutoCompact({ conversationId: convId, activeModel: MODELL })).toBeNull()

    expect(store).toHaveBeenCalled()
    expect(fensterAufloesen).toHaveBeenCalled()
  })

  it('ohne aktives Modell null, und ebenfalls vor dem Fenster', async () => {
    // Ohne Modell gibt es niemanden, der die Zusammenfassung schreiben koennte.
    // Die Pruefung MUSS vor dem Aufloesen stehen, denn das Aufloesen fragt
    // genau dieses Modell — mit null in der Hand ginge die Frage ins Leere.
    const convId = seedGespraech()
    setzeSchwelle(0.8)
    const store = beobachteStore()

    expect(await maybeAutoCompact({ conversationId: convId, activeModel: null })).toBeNull()

    expect(fensterAufloesen).not.toHaveBeenCalled()
    // Der Store wird ebenfalls nicht gebraucht: der Ausgang steht schon fest.
    expect(store).not.toHaveBeenCalled()
  })

  it('ein Gespraech, das es nicht mehr gibt, endet ebenfalls ohne Fenster', async () => {
    setzeSchwelle(0.8)
    useChatStore.setState({ conversations: [], activeConversationId: null })

    expect(await maybeAutoCompact({ conversationId: 'weg', activeModel: MODELL })).toBeNull()
    expect(fensterAufloesen).not.toHaveBeenCalled()
  })
})

// ── Die Verdrahtung ────────────────────────────────────────────────────────

/**
 * Die Sende-Hooks, aus dem Verzeichnis abgeleitet statt hier aufgezaehlt.
 *
 * Merkmal ist `endTurnDurably(`: das ruft genau der Code, der eine Modell-
 * Runde gegen ein Gespraech gefahren hat und sie abschliesst. Wer eine Runde
 * faehrt, baut vorher eine Anfrage aus der Historie — und genau dort gehoeren
 * beide Aufrufe hin. Das Merkmal ist bewusst NICHT compaction-bezogen, sonst
 * wuerde ein Hook, der beides vergisst, sich selbst aus der Pruefung nehmen.
 *
 * EHRLICHE GRENZE: ein vierter Sende-Pfad, der seine Runde ohne
 * endTurnDurably beendet, wird hier nicht erfasst. Das ist kein zweites
 * Versehen, sondern dasselbe — wer das Flush-Ende vergisst, verliert schon
 * die Persistenz der Runde und faellt in stores/durability auf.
 */
function sendePfadHooks(): string[] {
  return readdirSync(hooksDir)
    .filter((f) => f.startsWith('use') && f.endsWith('.ts'))
    .filter((f) => /\bendTurnDurably\s*\(/.test(lies(f)))
    .sort()
}

describe('Verdrahtung: jeder Sende-Pfad ruft maybeAutoCompact', () => {
  it('die Ableitung findet die drei bekannten Oberflaechen', () => {
    // Bricht das Merkmal weg, wird die Liste leer und alle Pruefungen unten
    // waeren still erfuellt. Diese Zeile ist die Sicherung darunter.
    const hooks = sendePfadHooks()
    expect(hooks).toEqual(
      expect.arrayContaining(['useAgentChat.ts', 'useChat.ts', 'useCodex.ts']),
    )
    expect(hooks.length).toBeGreaterThanOrEqual(3)
  })

  it.each(sendePfadHooks())('%s ruft maybeAutoCompact auf', (datei) => {
    // Ein Hook ohne diesen Aufruf verliert das Feature komplett und lautlos:
    // die Einstellung steht weiter da, auf dieser Oberflaeche passiert nur nie
    // etwas. Der Import allein zaehlt nicht, es muss ein Aufruf sein.
    expect(/\bmaybeAutoCompact\s*\(/.test(lies(datei))).toBe(true)
  })

  it.each(sendePfadHooks())('%s wendet applyStoredCompaction auf die Nutzlast an', (datei) => {
    // Die Gegenseite: aufzeichnen ohne anwenden heisst, die Zusammenfassung
    // wird bezahlt und die volle Historie trotzdem verschickt. Der Nutzer
    // saehe den Block im Verlauf und haette nichts davon.
    expect(/\bapplyStoredCompaction\s*\(/.test(lies(datei))).toBe(true)
  })
})


// ── Der stumme Fehlschlag ─────────────────────────────────────────────────

describe('Auto-Kompaktierung, die schiefgeht, sagt es', () => {
  const zusammenfassen = vi.mocked(runCompactSummary)

  beforeEach(() => {
    fensterAufloesen.mockClear()
    zusammenfassen.mockReset()
  })
  afterEach(() => { vi.restoreAllMocks() })

  /** Ein Gespraech, das die Schwelle sicher reisst. */
  function vollesGespraech(): string {
    const id = seedGespraech(MIN_MESSAGES_TO_COMPACT + 4)
    for (let i = 0; i < 40; i++) {
      useChatStore.getState().addMessage(id, {
        id: `lang${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(4000), timestamp: 1000 + i,
      })
    }
    return id
  }

  const hinweise = (id: string) =>
    (useChatStore.getState().conversations.find((c) => c.id === id)?.messages ?? [])
      .filter((m) => m.role === 'system' && !!m.notice)

  it('schreibt eine Warnung in den Verlauf, wenn das Modell nichts Brauchbares liefert', async () => {
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'unusable' } as never)

    const rec = await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(rec).toBeNull()

    // OHNE diese Zeile war der Fehlschlag komplett unsichtbar: null zurueck,
    // Senden laeuft weiter, und die Einstellung tut stumm nichts.
    const w = hinweise(id)
    expect(w).toHaveLength(1)
    expect(w[0].notice).toBe('warn')
    expect(w[0].content).toContain('Auto-compaction did not go through')
    // Der Grund steht mit drin, nicht nur die Tatsache.
    expect(w[0].content).toContain('did not produce a usable summary')
  })

  it('wiederholt dieselbe Warnung nicht bei jedem Senden', async () => {
    // Die Ursache besteht fort — ohne Bremse stuende die Warnung nach zehn
    // Nachrichten zehnmal da und der Chat waere unlesbar.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'unusable' } as never)

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })

    expect(hinweise(id)).toHaveLength(1)
  })

  it('warnt NICHT erneut, nur weil sich eine andere Notiz dazwischengeschoben hat', async () => {
    // Der Ablauf, der die erste Fassung erledigt hat: verglichen wurde gegen
    // den LETZTEN Hinweis im Verlauf. Seit eine fertige Hintergrundaufgabe
    // sich ebenfalls als Hinweis meldet, ist die Warnung staendig nicht mehr
    // die letzte — und dieselbe Ursache schrieb sie jedes Mal neu. Mit fuenf
    // Hintergrundagenten stand derselbe Satz fuenfmal da.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'unusable' } as never)

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(hinweise(id)).toHaveLength(1)

    useChatStore.getState().addMessage(id, {
      id: 'bg-task-abc', role: 'system', notice: 'info',
      content: 'Background agent [task-abc] finished: fertig', timestamp: Date.now(),
    })

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    const warnungen = hinweise(id).filter((m) => m.id.startsWith('autocompact-fail-'))
    expect(warnungen).toHaveLength(1)
  })

  it('warnt wieder, wenn genug Gespraech vergangen ist', async () => {
    // Die Gegenrichtung, und sie ist der Grund, warum "nur einmal" falsch
    // waere: warnt es bei Nachricht 20 und scheitert danach sechzig Mal
    // weiter, bliebe es sechzig Nachrichten still — waehrend der Zaehler
    // daneben "triggers on the next message" sagt. Also genau der Zustand,
    // gegen den diese Warnung gebaut wurde.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'unusable' } as never)

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(hinweise(id).filter((m) => m.id.startsWith('autocompact-fail-'))).toHaveLength(1)

    for (let i = 0; i < MIN_MESSAGES_SINCE_COMPACT; i++) {
      useChatStore.getState().addMessage(id, {
        id: `spaeter${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'weiter', timestamp: Date.now(),
      })
    }

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(hinweise(id).filter((m) => m.id.startsWith('autocompact-fail-'))).toHaveLength(2)
  })

  it('erkennt die eigene Warnung am Id-Praefix, nicht am Wortlaut', async () => {
    // `compactOutcomeMessage` buendelt mehrere Restgruende auf DENSELBEN Satz.
    // Ein Textvergleich haette zwei verschiedene Ursachen nicht auseinander-
    // gehalten — und, schlimmer, eine fremde Notiz mit zufaellig gleichem
    // Wortlaut faelschlich als eigene Warnung gelesen.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'unusable' } as never)
    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })

    const [w] = hinweise(id).filter((m) => m.id.startsWith('autocompact-fail-'))
    expect(w).toBeDefined()
    // Eine gleichlautende Notiz ohne das Praefix darf die Sperre nicht setzen.
    const id2 = vollesGespraech()
    useChatStore.getState().addMessage(id2, {
      id: 'fremd-1', role: 'system', notice: 'warn',
      content: w.content, timestamp: Date.now(),
    })
    await maybeAutoCompact({ conversationId: id2, activeModel: MODELL })
    expect(hinweise(id2).filter((m) => m.id.startsWith('autocompact-fail-'))).toHaveLength(1)
  })

  it('sagt nichts, wenn der Nutzer selbst abgebrochen hat', async () => {
    // Er hat auf Stopp gedrueckt; ihm zu melden, dass daraufhin gestoppt
    // wurde, ist Laerm.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'aborted' } as never)

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(hinweise(id)).toHaveLength(0)
  })

  it('sagt nichts, wenn es schlicht nichts zusammenzufassen gab', async () => {
    // Dieser Weg laeuft VOR JEDEM SENDEN. Eine Zeile fuer "nichts zu tun"
    // waere eine Zeile pro Nachricht.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: false, reason: 'nothing-to-compact' } as never)

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(hinweise(id)).toHaveLength(0)
  })

  it('meldet den Erfolg GENAU einmal — und zwar am Ende', async () => {
    // Diese Zusicherung hiess bis zum 03.09.2026 „schreibt nichts in den
    // Verlauf, wenn es geklappt hat", begruendet mit: der Erfolg habe seine
    // eigene Darstellung, den Compact-Block an der Schnittstelle, ein
    // zusaetzlicher Hinweis waere dasselbe zweimal.
    //
    // Die Praemisse stimmt zur Haelfte. Den Block gibt es wirklich
    // (CompactBlock, verankert per compactionAnchors) — aber er steht am
    // SCHNITTPUNKT, also mitten in einem Gespraech, das gerade lang genug
    // geworden ist, um verdichtet zu werden. Der Leser steht in diesem Moment
    // unten am Eingabefeld, dreissig Nachrichten weiter. Eine Persona hat
    // genau dort gestanden, den Ueberlauf komplett verpasst und ihn erst im
    // Netzwerkverkehr gefunden.
    //
    // Die Sorge des alten Tests bleibt trotzdem richtig, deshalb steht sie
    // jetzt als Zahl da: GENAU eine Notiz, nicht zwei. Der Block sagt, WO
    // geschnitten wurde; die Notiz sagt, DASS es eben passiert ist, an der
    // Stelle, auf die der Leser ohnehin schaut.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({
      ok: true,
      summary: { task: 'T', requests: 'R', progress: 'P', decisions: 'D', facts: 'F', open: 'O', rest: '' },
    } as never)

    const rec = await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(rec).not.toBeNull()
    expect(hinweise(id)).toHaveLength(1)
  })
})


// ── Ein Nenner fuer Anzeige UND Entscheidung ──────────────────────────────

describe('Der Auto-Ausloeser rechnet gegen das SENDEfenster, nicht das Modellfenster', () => {
  const zusammenfassen = vi.mocked(runCompactSummary)

  beforeEach(() => {
    fensterAufloesen.mockClear()
    zusammenfassen.mockReset()
  })
  afterEach(() => { vi.restoreAllMocks() })

  /**
   * WARUM: die Agentenschleife baut ihre Nachrichten gegen
   * `effectiveSendWindow` — einen Anteil des Modellfensters, bei bezahlten
   * Anbietern zusaetzlich gekappt. Derselbe Wert ist der Nenner des
   * Fuellbalkens. Der Ausloeser nahm stattdessen das rohe Modellfenster.
   *
   * Folge, bevor das behoben war: Balken bei 94 % samt "triggers on the next
   * message", Ausloeser rechnet 0.3 und tut nie etwas. Nicht einmal, sondern
   * fuer immer — der Nutzer sieht eine eingeschaltete Funktion, die stumm
   * nichts tut, und das ist der Zustand, den dieser ganze Bereich vermeiden
   * soll.
   */
  it('kompaktiert, wenn das SENDEfenster voll ist, obwohl das Modellfenster Platz haette', async () => {
    // 32768 Modellfenster (die Attrappe), davon geht `effectiveSendWindow`
    // auf einen Anteil herunter. Ein Gespraech, das den Anteil reisst, aber
    // unter dem rohen Fenster bliebe, muss ausloesen.
    setzeSchwelle(0.8)
    const id = seedGespraech(MIN_MESSAGES_TO_COMPACT + 4)
    // ~21k Zeichen ≈ 5,3k Token: ueber 0.8 des Anteils, deutlich unter 0.8
    // des rohen 32768er-Fensters.
    for (let i = 0; i < 22; i++) {
      useChatStore.getState().addMessage(id, {
        id: `f${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'y'.repeat(4000), timestamp: 2000 + i,
      })
    }
    zusammenfassen.mockResolvedValue({
      ok: true,
      summary: { task: 'T', requests: 'R', progress: 'P', decisions: 'D', facts: 'F', open: 'O', rest: '' },
    } as never)

    const rec = await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(rec).not.toBeNull()
  })

  it('laesst ein selbst uebergebenes Fenster unangetastet', async () => {
    // Der einfache Chat waehlt seinen Nenner selbst (`modelWindowTokens`) und
    // kennt die Sende-Kappe der Agentenschleife gar nicht. Wer `window`
    // uebergibt, bekommt genau dieses — sonst haette der Parameter keinen Sinn.
    setzeSchwelle(0.8)
    const id = seedGespraech(MIN_MESSAGES_TO_COMPACT + 4)
    zusammenfassen.mockReset()

    // Riesiges Fenster, kurzer Chat: nichts darf passieren, und der Aufloeser
    // darf gar nicht erst gefragt werden.
    const rec = await maybeAutoCompact({
      conversationId: id, activeModel: MODELL, window: 1_000_000, windowIsTrue: true,
    })
    expect(rec).toBeNull()
    expect(fensterAufloesen).not.toHaveBeenCalled()
    expect(zusammenfassen).not.toHaveBeenCalled()
  })
})


// ── Der stumme Erfolg ─────────────────────────────────────────────────────

describe('Auto-Kompaktierung, die klappt, sagt es auch', () => {
  // Eine Persona hat am 03.09.2026 ein langes Gespraech gefahren und den
  // Ueberlauf erst im Netzwerkverkehr gefunden: im Fenster stand weiter der
  // volle Text, geschickt wurde er nicht mehr. Ihr Satz dazu: „Ich glaube, das
  // Werkzeug hat alles, und uebernehme falsche Zahlen in einen Artikel."
  //
  // Die Asymmetrie war der Fehler. Ein FEHLSCHLAG schrieb seit jeher eine
  // sichtbare Notiz in den Verlauf — der ERFOLG schrieb nichts, obwohl genau
  // er aendert, was das Modell noch sieht. Der Kunde erfuhr also nur, wenn es
  // NICHT geklappt hat.
  const zusammenfassen = vi.mocked(runCompactSummary)
  const ZUSAMMENFASSUNG = { task: 'T', requests: 'R', progress: 'P', decisions: 'D', facts: 'F', open: 'O', rest: '' }

  beforeEach(() => {
    fensterAufloesen.mockClear()
    zusammenfassen.mockReset()
  })
  afterEach(() => { vi.restoreAllMocks() })

  function vollesGespraech(): string {
    const id = seedGespraech(MIN_MESSAGES_TO_COMPACT + 4)
    for (let i = 0; i < 40; i++) {
      useChatStore.getState().addMessage(id, {
        id: `lang${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(4000), timestamp: 1000 + i,
      })
    }
    return id
  }

  const hinweise = (id: string) =>
    (useChatStore.getState().conversations.find((c) => c.id === id)?.messages ?? [])
      .filter((m) => m.role === 'system' && !!m.notice)

  it('hinterlaesst eine sichtbare Notiz im Verlauf', async () => {
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: true, summary: ZUSAMMENFASSUNG } as never)

    const rec = await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    expect(rec).not.toBeNull()

    const n = hinweise(id)
    expect(n).toHaveLength(1)
    // Kein 'warn': es ist nichts schiefgegangen, es ist etwas passiert.
    expect(n[0].notice).toBe('info')
    expect(n[0].content).toContain('Summarised')
    // Der Satz, der die Angst nimmt — der Verlauf ist nicht weg, nur die
    // Nutzlast ist kuerzer. Ohne ihn liest sich die Notiz wie ein Datenverlust.
    expect(n[0].content).toContain('The full conversation is still here')
  })

  it('die Notiz steht NACH den Nachrichten, die sie ersetzt', async () => {
    // Am Schnittpunkt, nicht am Anfang: sonst behauptet sie, das ganze
    // Gespraech sei zusammengefasst.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: true, summary: ZUSAMMENFASSUNG } as never)

    await maybeAutoCompact({ conversationId: id, activeModel: MODELL })
    const alle = useChatStore.getState().conversations.find((c) => c.id === id)!.messages
    expect(alle[alle.length - 1].notice).toBe('info')
  })

  it('der manuelle Weg verdoppelt die Notiz nicht', async () => {
    // /compact zeigt sein Ergebnis selbst an. Zwei Notizen fuer einen Vorgang
    // waeren eine Falschmeldung ueber die Anzahl der Vorgaenge.
    setzeSchwelle(0.5)
    const id = vollesGespraech()
    zusammenfassen.mockResolvedValue({ ok: true, summary: ZUSAMMENFASSUNG } as never)

    await runCompactForConversation({ conversationId: id, activeModel: MODELL, trigger: 'manual' })
    expect(hinweise(id)).toHaveLength(0)
  })
})
