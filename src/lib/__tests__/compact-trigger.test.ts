/**
 * Sperrklinken für die Auto-Compact-Entscheidung (2.6.8, Compact-Schritt 1).
 *
 * Die wichtigste Zusicherung steht ganz oben und ist eine Negativ-Aussage:
 * ohne gesetzte Schwelle darf dieses Modul NICHTS auslösen. Die Entscheidung
 * vom 02.09.2026 war "einstellbar sonst aus", und ein Standardwert, der sich
 * später einschleicht, wäre genau der Fehler, den diese Datei verhindern soll.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldAutoCompact,
  autoCompactHint,
  confidenceMargin,
  numeratorMargin,
  usableThreshold,
  MARGIN_BUILT,
  MARGIN_USAGE_REAL,
  MARGIN_USAGE_ESTIMATED,
  MARGIN_ESTIMATE,
  MARGIN_WINDOW_GUESSED,
  MIN_EFFECTIVE_THRESHOLD,
  MIN_THRESHOLD,
  MAX_THRESHOLD,
  MIN_MESSAGES_TO_COMPACT,
  MIN_MESSAGES_SINCE_COMPACT,
  type CompactTriggerInput,
} from '../compact-trigger'
import { computeContextFill, type FillMessage } from '../token-usage'

/** Ein Fall, der ohne Zutun feuern WÜRDE — jede Prüfung variiert genau ein Feld. */
const feuernd: CompactTriggerInput = {
  used: 9000,
  window: 10000,
  source: 'built',
  real: false,
  windowIsTrue: true,
  messageCount: 40,
  threshold: 0.8,
}

describe('opt-in: ohne Schwelle passiert nichts', () => {
  it('feuert nicht ohne Schwelle', () => {
    const r = shouldAutoCompact({ ...feuernd, threshold: undefined })
    expect(r.shouldCompact).toBe(false)
    expect(r.reason).toBe('off')
  })

  it('feuert nicht bei Schwelle 0 — der Aus-Zustand der Einstellung', () => {
    expect(shouldAutoCompact({ ...feuernd, threshold: 0 }).reason).toBe('off')
  })

  it('feuert nicht bei unsinnigen Werten', () => {
    for (const t of [NaN, Infinity, -1, 0.1, 0.99, 2]) {
      expect(shouldAutoCompact({ ...feuernd, threshold: t }).reason).toBe('off')
    }
  })

  it('usableThreshold nimmt nur den erlaubten Bereich an', () => {
    expect(usableThreshold(MIN_THRESHOLD)).toBe(MIN_THRESHOLD)
    expect(usableThreshold(MAX_THRESHOLD)).toBe(MAX_THRESHOLD)
    expect(usableThreshold(MIN_THRESHOLD - 0.01)).toBeNull()
    expect(usableThreshold(MAX_THRESHOLD + 0.01)).toBeNull()
    expect(usableThreshold(undefined)).toBeNull()
  })

  it('derselbe Fall feuert, sobald eine Schwelle gesetzt ist', () => {
    expect(shouldAutoCompact(feuernd).shouldCompact).toBe(true)
    expect(shouldAutoCompact(feuernd).reason).toBe('over')
  })
})

describe('der Nenner muss aufgelöst sein', () => {
  it('feuert nicht, solange das Fenster 0 ist', () => {
    const r = shouldAutoCompact({ ...feuernd, window: 0 })
    expect(r.reason).toBe('no-window')
    expect(r.ratio).toBe(0)
  })
})

describe('zu kurz zum Zusammenfassen', () => {
  it('feuert unterhalb der Mindestlänge nicht', () => {
    const r = shouldAutoCompact({ ...feuernd, messageCount: MIN_MESSAGES_TO_COMPACT - 1 })
    expect(r.reason).toBe('too-short')
  })

  it('feuert genau ab der Mindestlänge', () => {
    expect(
      shouldAutoCompact({ ...feuernd, messageCount: MIN_MESSAGES_TO_COMPACT }).shouldCompact,
    ).toBe(true)
  })
})

describe('Abklingzeit: keine Zusammenfassung der Zusammenfassung', () => {
  it('feuert nicht direkt nach einer Kürzung', () => {
    const r = shouldAutoCompact({ ...feuernd, messageCount: 40, lastCompactAtMessageCount: 38 })
    expect(r.reason).toBe('cooldown')
  })

  it('feuert wieder, sobald genug Neues dazugekommen ist', () => {
    const r = shouldAutoCompact({
      ...feuernd,
      messageCount: 40,
      lastCompactAtMessageCount: 40 - MIN_MESSAGES_SINCE_COMPACT,
    })
    expect(r.shouldCompact).toBe(true)
  })

  it('ohne frühere Kürzung greift die Abklingzeit nicht', () => {
    expect(shouldAutoCompact({ ...feuernd, lastCompactAtMessageCount: undefined }).shouldCompact)
      .toBe(true)
  })

  // Der Fall, für den die Abklingzeit da ist: ein einzelnes riesiges
  // Werkzeugergebnis hält das Verhältnis auch NACH dem Kürzen über der
  // Schwelle. Ohne Sperre würde jeder folgende Zug erneut zusammenfassen.
  it('ein weiter volles Fenster löst nicht sofort erneut aus', () => {
    const nachKuerzung = { ...feuernd, used: 9500, messageCount: 41, lastCompactAtMessageCount: 40 }
    expect(shouldAutoCompact(nachKuerzung).shouldCompact).toBe(false)
  })
})

describe('der Verlässlichkeitsabschlag', () => {
  it('gibt es für einen gebauten Wert nicht', () => {
    expect(numeratorMargin('built', false)).toBe(MARGIN_BUILT)
    expect(MARGIN_BUILT).toBe(0)
  })

  it('wächst, je weiter die Zahl von der Messung weg ist', () => {
    expect(numeratorMargin('built', true)).toBeLessThan(numeratorMargin('usage', true))
    expect(numeratorMargin('usage', true)).toBeLessThan(numeratorMargin('usage', false))
    expect(numeratorMargin('usage', false)).toBeLessThan(numeratorMargin('estimate', false))
    expect(numeratorMargin('estimate', false)).toBe(MARGIN_ESTIMATE)
    expect(numeratorMargin('usage', true)).toBe(MARGIN_USAGE_REAL)
    expect(numeratorMargin('usage', false)).toBe(MARGIN_USAGE_ESTIMATED)
  })

  it('ein geratenes Fenster trägt einen eigenen Abschlag', () => {
    expect(confidenceMargin({ source: 'built', real: true, windowIsTrue: false }))
      .toBe(MARGIN_WINDOW_GUESSED)
  })

  // Das ist die Regel, die im Modulkopf begründet ist: der schlechteste
  // Abschlag gilt, nicht die Summe. Sonst wird aus einer eingestellten 0,8
  // still eine 0,6, und die Zahl in den Einstellungen bedeutet nichts mehr.
  it('nimmt den schlechtesten Abschlag, nicht die Summe', () => {
    const beides = confidenceMargin({ source: 'estimate', real: false, windowIsTrue: false })
    expect(beides).toBe(Math.max(MARGIN_ESTIMATE, MARGIN_WINDOW_GUESSED))
    expect(beides).toBeLessThan(MARGIN_ESTIMATE + MARGIN_WINDOW_GUESSED)
  })

  it('zieht die Schwelle vor, wo die Zahlen unsicher sind', () => {
    const sicher = shouldAutoCompact({ ...feuernd, source: 'built', windowIsTrue: true })
    const unsicher = shouldAutoCompact({ ...feuernd, source: 'estimate', windowIsTrue: false })
    expect(unsicher.effectiveThreshold).toBeLessThan(sicher.effectiveThreshold)
    expect(sicher.effectiveThreshold).toBe(0.8)
  })

  // Genau der Fall, für den der Abschlag existiert: die Schätzung liest zu
  // niedrig, das geratene Fenster zu hoch, das Verhältnis landet unter der
  // eingestellten Schwelle — obwohl in Wahrheit schon gekürzt werden müsste.
  it('feuert bei unsicheren Zahlen dort, wo die rohe Schwelle noch schwiege', () => {
    const knapp = { ...feuernd, used: 7200, window: 10000, threshold: 0.8 }
    expect(shouldAutoCompact({ ...knapp, source: 'built', windowIsTrue: true }).shouldCompact)
      .toBe(false)
    expect(shouldAutoCompact({ ...knapp, source: 'estimate', windowIsTrue: false }).shouldCompact)
      .toBe(true)
  })

  it('unterschreitet nie den Boden', () => {
    const r = shouldAutoCompact({
      ...feuernd, threshold: MIN_THRESHOLD, source: 'estimate', windowIsTrue: false,
    })
    expect(r.effectiveThreshold).toBe(MIN_EFFECTIVE_THRESHOLD)
    expect(r.effectiveThreshold).toBeGreaterThanOrEqual(MIN_EFFECTIVE_THRESHOLD)
  })
})

describe('das Verhältnis selbst', () => {
  it('wird nicht bei 1 gekappt — ein übervolles Fenster soll als solches lesbar sein', () => {
    expect(shouldAutoCompact({ ...feuernd, used: 25000, window: 10000 }).ratio).toBe(2.5)
  })

  it('meldet das Verhältnis auch dann, wenn nicht gefeuert wird', () => {
    const r = shouldAutoCompact({ ...feuernd, threshold: undefined })
    expect(r.ratio).toBeCloseTo(0.9)
    expect(r.shouldCompact).toBe(false)
  })
})

describe('zusammen mit der echten Füllstandsrechnung', () => {
  const msg = (role: string, content: string, extra: Partial<FillMessage> = {}): FillMessage =>
    ({ role, content, ...extra })

  it('nimmt Herkunft und Verlässlichkeit von computeContextFill entgegen', () => {
    // Ein Verlauf ohne jede Modell-Rückmeldung: reine Schätzung.
    const nurSchaetzung = Array.from({ length: 20 }, (_, i) => msg('user', 'x'.repeat(2000) + i))
    const fill = computeContextFill(nurSchaetzung)
    expect(fill.source).toBe('estimate')

    const r = shouldAutoCompact({
      used: fill.used,
      window: 16384,
      source: fill.source,
      real: fill.real,
      windowIsTrue: true,
      messageCount: nurSchaetzung.length,
      threshold: 0.8,
    })
    expect(r.margin).toBe(MARGIN_ESTIMATE)
    expect(r.effectiveThreshold).toBeCloseTo(0.8 - MARGIN_ESTIMATE)
  })

  it('ein gebauter Anker führt zum Abschlag null', () => {
    const verlauf = Array.from({ length: 12 }, () => msg('user', 'hallo'))
    const fill = computeContextFill(verlauf, { tokens: 14000, atMessageCount: 12 })
    expect(fill.source).toBe('built')

    const r = shouldAutoCompact({
      used: fill.used,
      window: 16384,
      source: fill.source,
      real: fill.real,
      windowIsTrue: true,
      messageCount: verlauf.length,
      threshold: 0.8,
    })
    expect(r.margin).toBe(0)
    expect(r.effectiveThreshold).toBe(0.8)
    expect(r.shouldCompact).toBe(true)
  })
})

// ── Die Anzeige: wie weit ist es noch ─────────────────────────────────────

describe('autoCompactHint — der Satz neben dem Fuellbalken', () => {
  const urteil = (over: Partial<CompactTriggerInput> = {}) =>
    shouldAutoCompact({
      used: 1000, window: 10_000, source: 'estimate', real: false,
      windowIsTrue: true, messageCount: MIN_MESSAGES_TO_COMPACT + 5,
      threshold: 0.8, ...over,
    })

  it('sagt gar nichts, wenn die Auto-Kompaktierung aus ist', () => {
    // Der ausgelieferte Zustand. Ein Hinweis auf ein abgeschaltetes Feature
    // waere Werbung, kein Statustext.
    expect(autoCompactHint(null)).toBe('')
    expect(autoCompactHint(urteil({ threshold: 0 }))).toBe('')
  })

  it('nennt den Rest in Prozentpunkten DES FENSTERS', () => {
    // 10 % voll, wirksame Schwelle 80 % (echtes Fenster, kein Abschlag noetig)
    // → 70 Punkte Luft. Der Nutzer findet die Zahl direkt am Balken wieder;
    // ein Anteil der Restspanne taete das nicht.
    const u = urteil({ used: 1000, real: true, source: 'usage' })
    expect(autoCompactHint(u)).toMatch(/^\d+% of the window left before auto-compaction$/)
    const prozent = Number(autoCompactHint(u).match(/^(\d+)%/)![1])
    expect(prozent).toBe(Math.round((u.effectiveThreshold - u.ratio) * 100))
  })

  it('rechnet mit der WIRKSAMEN Schwelle, nicht mit der eingestellten', () => {
    // Der eigentliche Grund, warum diese Funktion das fertige Urteil bekommt
    // statt selbst zu rechnen. Bei geschaetztem Fuellstand zieht
    // shouldAutoCompact einen Sicherheitsabschlag ab — wer die eingestellten
    // 80 % anzeigte, naennte eine Marke, bei der nichts passiert.
    const geschaetzt = urteil({ used: 1000, real: false, source: 'estimate' })
    const gemessen = urteil({ used: 1000, real: true, source: 'usage' })
    expect(geschaetzt.effectiveThreshold).toBeLessThan(gemessen.effectiveThreshold)
    const p = (t: string) => Number(t.match(/^(\d+)%/)![1])
    expect(p(autoCompactHint(geschaetzt))).toBeLessThan(p(autoCompactHint(gemessen)))
  })

  it('kuendigt an, wenn es beim naechsten Mal soweit ist', () => {
    // Die einzige Zeile, die der Nutzer VOR der Ueberraschung liest.
    expect(autoCompactHint(urteil({ used: 9500, real: true, source: 'usage' })))
      .toBe('Auto-compaction triggers on the next message')
  })

  it('nennt keine Prozentzahl, solange das Fenster unbekannt ist', () => {
    // Ein Prozentwert auf einen Nenner, den niemand kennt, waere erfunden.
    const t = autoCompactHint(urteil({ window: 0 }))
    expect(t).toContain('waiting for the model to report its context window')
    expect(t).not.toMatch(/\d+%/)
  })

  it('unterscheidet "noch zu kurz" von "noch viel Platz"', () => {
    // Zwei verschiedene Gruende, nichts zu tun. Wer sie zusammenwirft, laesst
    // den Nutzer auf eine Kompaktierung warten, die bei 12 Nachrichten gar
    // nicht kommen kann.
    const kurz = autoCompactHint(urteil({ messageCount: 2 }))
    expect(kurz).toContain(`from ${MIN_MESSAGES_TO_COMPACT} messages`)
    expect(kurz).not.toContain('% of the window')
  })

  it('sagt es, wenn nur die Abkuehlzeit im Weg steht', () => {
    const t = autoCompactHint(urteil({
      used: 9500, real: true, source: 'usage',
      lastCompactAtMessageCount: MIN_MESSAGES_TO_COMPACT + 4,
    }))
    expect(t).toContain('paused briefly after the last summary')
  })
})
