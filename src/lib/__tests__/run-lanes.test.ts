/**
 * Die lokale Spur: einer rechnet, der Rest stellt sich an.
 *
 * Zwei Sorten von Zusicherungen stehen hier, und die zweite ist die
 * ungewoehnliche:
 *
 *  1. Das Verhalten. Wer startet, wer wartet, wer nachrueckt, und vor allem:
 *     wer die Spur NICHT freigeben darf. Ein `release` von der falschen Seite
 *     waere ein Generalschluessel: er raeumte den Platz eines Fremden, und
 *     zwei lokale Laeufe liefen wieder nebeneinander, ohne dass irgendwo ein
 *     Fehler auftaucht.
 *
 *  2. Der Grund im Quelltext. `run-lanes.ts` traegt eine Begruendung, warum
 *     die Sperre an der KONVERSATION haengt und nicht an der Anfrage. Diese
 *     Begruendung ist der ganze Wert der Datei. Die naheliegende Umbauidee,
 *     eine Sperre pro Anbieteranfrage, viel einfacher zu schreiben, ist ein
 *     garantierter Selbstblockierer, und das sieht man ihr nicht an. Ein
 *     Kommentar, der eine solche Falle beschreibt, ist Infrastruktur; wird er
 *     wegeditiert, baut ihn der naechste guten Gewissens wieder ein. Also
 *     steht hier ein Waechter darauf.
 *
 * Lauf: npx vitest run src/lib/__tests__/run-lanes.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resolve } from 'node:path'

import {
  admit,
  release,
  isRunQueued,
  anyRunQueued,
  localLaneHolder,
  queuedRunIds,
  subscribeRunLanes,
  localLaneSnapshot,
  runQueuePosition,
  __resetRunLanesForTests,
} from '../run-lanes'
import { quelldateien, quelltext } from '../../components/__tests__/quelldateien'

beforeEach(() => {
  __resetRunLanesForTests()
})

describe('cloud faehrt ohne Schranke', () => {
  it('vier Cloud-Laeufe starten alle vier sofort', () => {
    // Dort steht keine Karte des Nutzers dahinter. Eine Warteschlange waere
    // reine Bremse ohne Gegenwert.
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(admit('cloud', id, () => {})).toBe('started')
    }
    expect(anyRunQueued()).toBe(false)
    expect(localLaneHolder()).toBeNull()
  })

  it('ein Cloud-Lauf belegt die lokale Spur nicht, ein lokaler startet daneben', () => {
    admit('cloud', 'wolke', () => {})
    expect(admit('local', 'karte', () => {})).toBe('started')
  })

  it('release auf einen Cloud-Lauf raeumt den lokalen Halter NICHT weg', () => {
    // Der Generalschluessel-Fall. `release` bekommt nur eine Kennung; wenn es
    // die nicht gegen den Halter prueft, gibt jeder beliebige beendete Lauf
    // die lokale Spur frei.
    admit('local', 'karte', () => {})
    admit('cloud', 'wolke', () => {})
    expect(release('wolke')).toBeUndefined()
    expect(localLaneHolder()).toBe('karte')
  })
})

describe('lokal: einer haelt, der Rest wartet der Reihe nach', () => {
  it('der erste startet, die naechsten zwei reihen sich ein', () => {
    expect(admit('local', 'a', () => {})).toBe('started')
    expect(admit('local', 'b', () => {})).toBe('queued')
    expect(admit('local', 'c', () => {})).toBe('queued')
    expect(localLaneHolder()).toBe('a')
    expect(queuedRunIds()).toEqual(['b', 'c'])
  })

  it('FIFO: wer zuerst kam, kommt zuerst dran', () => {
    const gestartet: string[] = []
    admit('local', 'a', () => gestartet.push('a'))
    admit('local', 'b', () => gestartet.push('b'))
    admit('local', 'c', () => gestartet.push('c'))

    // Der Aufrufer ruft den Rueckgabewert. Hier steht die ganze Uebergabe.
    release('a')?.()
    expect(gestartet).toEqual(['b'])
    expect(localLaneHolder()).toBe('b')

    release('b')?.()
    expect(gestartet).toEqual(['b', 'c'])
    expect(localLaneHolder()).toBe('c')

    expect(release('c')).toBeUndefined()
    expect(localLaneHolder()).toBeNull()
    expect(anyRunQueued()).toBe(false)
  })

  it('der Platz ist beim Zurueckkehren aus release schon vergeben', () => {
    // Sonst schoebe sich zwischen dem Freiwerden und dem Anlaufen des
    // Naechsten ein Dritter dazwischen, und beide rechneten auf derselben
    // Karte, also genau der Zustand, den die Spur verhindern soll.
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    release('a')
    expect(localLaneHolder()).toBe('b')
    expect(admit('local', 'c', () => {})).toBe('queued')
  })

  it('der `start` des Wartenden wird NICHT von admit oder release selbst gerufen', () => {
    // Liefe er im Rahmen von release an, schluepfte ein Fehler des naechsten
    // Laufs in die Abwicklung des vorigen.
    let gelaufen = 0
    admit('local', 'a', () => { gelaufen++ })
    admit('local', 'b', () => { gelaufen++ })
    expect(gelaufen).toBe(0)
    const naechster = release('a')
    expect(gelaufen).toBe(0)
    naechster?.()
    expect(gelaufen).toBe(1)
  })
})

describe('abbrechen, bevor man dran war', () => {
  it('der Wartende faellt aus der Schlange, und niemand rueckt nach', () => {
    // Der Halter rechnet ja weiter. Wuerde hier nachgerueckt, liefen zwei.
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    admit('local', 'c', () => {})

    expect(release('b')).toBeUndefined()
    expect(localLaneHolder()).toBe('a')
    expect(queuedRunIds()).toEqual(['c'])
    expect(isRunQueued('b')).toBe(false)
  })

  it('nach dem Abbruch kommt der uebernaechste dran, nicht der abgebrochene', () => {
    const gestartet: string[] = []
    admit('local', 'a', () => gestartet.push('a'))
    admit('local', 'b', () => gestartet.push('b'))
    admit('local', 'c', () => gestartet.push('c'))
    release('b')
    release('a')?.()
    expect(gestartet).toEqual(['c'])
  })
})

describe('DER SELBSTBLOCKIERER: dieselbe Konversation fragt noch einmal', () => {
  it('ein Elternlauf, der die Spur haelt, kommt an seiner eigenen Schranke vorbei', () => {
    // DAS ist die Eigenschaft, an der ein Deadlock haengt. Ein Elternlauf
    // haelt die Spur und wartet auf einen Vordergrund-Sub-Agenten
    // (sub-agent.ts: `return await runner(...)`), der ueber dieselbe Ebene
    // laeuft. Kaeme dabei noch einmal eine Frage hier an und wuerde sie mit
    // 'queued' beantwortet, wartete der Sub-Agent auf eine Spur, die sein
    // eigener Elternlauf haelt, und der Elternlauf auf ihn. Beide fuer immer.
    expect(admit('local', 'eltern', () => {})).toBe('started')
    expect(admit('local', 'eltern', () => {})).toBe('started')
    expect(anyRunQueued()).toBe(false)
    expect(localLaneHolder()).toBe('eltern')
  })

  it('und er gibt dabei nicht den Platz eines anderen frei', () => {
    admit('local', 'eltern', () => {})
    admit('local', 'anderer', () => {})
    admit('local', 'eltern', () => {})
    expect(queuedRunIds()).toEqual(['anderer'])
  })

  it('ein Wartender, der noch einmal fragt, steht nicht zweimal an', () => {
    // Sonst braeuchte er zwei `release`, und das zweite raeumte den Platz
    // dessen, der dann gerade haelt.
    admit('local', 'a', () => {})
    expect(admit('local', 'b', () => {})).toBe('queued')
    expect(admit('local', 'b', () => {})).toBe('queued')
    expect(queuedRunIds()).toEqual(['b'])
  })
})

describe('ein Lauf ohne Kennung kann die Spur nicht verklemmen', () => {
  it('er nimmt den Platz gar nicht erst', () => {
    // Er koennte ihn nie zurueckgeben, denn `release` findet ihn ueber die
    // Kennung. Langsam (zwei lokale Laeufe) schlaegt tot (Spur fuer den Rest
    // der Sitzung besetzt).
    expect(admit('local', '', () => {})).toBe('started')
    expect(localLaneHolder()).toBeNull()
    expect(admit('local', 'a', () => {})).toBe('started')
    expect(localLaneHolder()).toBe('a')
  })

  it('GEGENPROBE: release ohne Kennung raeumt nichts weg', () => {
    admit('local', 'a', () => {})
    expect(release('')).toBeUndefined()
    expect(localLaneHolder()).toBe('a')
  })
})

describe('die Fragen, die run-idle.ts stellt', () => {
  it('isRunQueued gilt nur fuer Wartende, nicht fuer den Halter', () => {
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    expect(isRunQueued('a')).toBe(false)
    expect(isRunQueued('b')).toBe(true)
    expect(isRunQueued(null)).toBe(false)
    expect(isRunQueued(undefined)).toBe(false)
  })

  it('anyRunQueued faellt zurueck, sobald der Letzte drankommt', () => {
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    expect(anyRunQueued()).toBe(true)
    release('a')?.()
    expect(anyRunQueued()).toBe(false)
  })
})

// ── Der Grund muss im Quelltext stehen bleiben ──────────────────────────────
const SRC = resolve(__dirname, '..', '..')
const DATEIEN = quelldateien(resolve(SRC, 'lib'), { endungen: /\.ts$/, relativZu: SRC })

describe('die Begruendung ueberlebt den naechsten Umbau', () => {
  const QUELLE = quelltext(DATEIEN, 'lib/run-lanes.ts')

  it('warum lokal serialisiert wird: VRAM-Tausch, nicht Vorsicht', () => {
    // Ohne diesen Grund liest sich die Warteschlange wie eine willkuerliche
    // Bremse, und die erste Beschwerde ueber Langsamkeit raeumt sie weg.
    expect(QUELLE).toContain('VRAM')
    expect(QUELLE).toMatch(/Ollama/)
    expect(QUELLE).toMatch(/langsamer/)
  })

  it('warum die Sperre an der Konversation haengt und nicht an der Anfrage', () => {
    // Die naheliegende Umbauidee ist ein garantierter Selbstblockierer. Steht
    // der Grund nicht daneben, ist der Umbau eine Vereinfachung, die jeder
    // Gutachter durchwinkt.
    expect(QUELLE).toContain('sub-agent.ts')
    expect(QUELLE).toContain('chatWithTools')
    expect(QUELLE).toMatch(/warten f[uü]r\s+immer|Selbstblockierer/)
  })

  it('und die Pflicht, den Platz zurueckzugeben, steht bei admit', () => {
    expect(QUELLE).toMatch(/finally/)
    expect(QUELLE).toMatch(/release/)
  })
})

// ── Die Schlange muss ablesbar UND beobachtbar sein ─────────────────────────
//
// Zwei Loecher, die derselbe Griff stopft:
//
//  1. Die Oberflaeche soll ein Warteplaettchen zeigen ("wartet auf die
//     Grafikkarte, Platz 2"). Sie kann das nur, wenn sie die Reihenfolge
//     bekommt UND gesagt bekommt, wann sie sich aendert. Modulzustand weckt
//     React von sich aus nicht.
//  2. `run-idle.ts` trug dafuer eine EHRLICHE LUECKE im Kopf: faellt der
//     letzte Wartende aus der Schlange, aendert das keinen der beiden
//     Speicher, an denen `whenRunsIdle` haengt. Ein aufgeschobener Dialog
//     wartete dann auf die naechste fremde Aenderung.
describe('die Schlange sagt Bescheid, wenn sie sich aendert', () => {
  it('Anstellen, Nachruecken und Ausscheiden wecken den Beobachter', () => {
    let geweckt = 0
    const ab = subscribeRunLanes(() => { geweckt++ })

    admit('local', 'a', () => {})   // Halter genommen
    expect(geweckt).toBe(1)
    admit('local', 'b', () => {})   // angestellt
    expect(geweckt).toBe(2)
    admit('local', 'c', () => {})
    expect(geweckt).toBe(3)
    release('b')                    // ausgeschieden, ohne Nachruecken
    expect(geweckt).toBe(4)
    release('a')                    // Nachruecken
    expect(geweckt).toBe(5)
    release('c')                    // Spur frei
    expect(geweckt).toBe(6)
    ab()
  })

  it('GEGENPROBE: ein Cloud-Lauf und ein wirkungsloses release wecken niemanden', () => {
    // Sonst zappelt die Oberflaeche bei jedem Cloud-Lauf, obwohl sich an der
    // Karte nichts getan hat.
    let geweckt = 0
    const ab = subscribeRunLanes(() => { geweckt++ })
    admit('cloud', 'wolke', () => {})
    expect(geweckt).toBe(0)
    release('gibt-es-nicht')
    expect(geweckt).toBe(0)
    ab()
  })

  it('GEGENPROBE: ein abgemeldeter Beobachter wird nicht mehr geweckt', () => {
    let geweckt = 0
    const ab = subscribeRunLanes(() => { geweckt++ })
    ab()
    admit('local', 'a', () => {})
    expect(geweckt).toBe(0)
  })

  it('ein werfender Beobachter reisst die Spur nicht mit', () => {
    // Die Spur ist die gefaehrlichste Stelle der App: bleibt sie haengen,
    // steht jeder weitere lokale Lauf bis zum Neustart. Ein Fehler in einer
    // fremden Anzeige darf das nicht ausloesen.
    const ab = subscribeRunLanes(() => { throw new Error('Anzeige kaputt') })
    expect(() => admit('local', 'a', () => {})).not.toThrow()
    expect(localLaneHolder()).toBe('a')
    expect(() => release('a')).not.toThrow()
    expect(localLaneHolder()).toBeNull()
    ab()
  })
})

describe('die Momentaufnahme fuer die Oberflaeche', () => {
  it('nennt Halter und Wartende in ihrer Reihenfolge', () => {
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    admit('local', 'c', () => {})
    expect(localLaneSnapshot()).toEqual({ holder: 'a', queued: ['b', 'c'] })
  })

  it('behaelt ihre Identitaet, solange sich nichts aendert', () => {
    // `useSyncExternalStore` vergleicht die Momentaufnahmen mit ===. Ein
    // frisches Objekt bei jedem Abruf ist dort kein Schoenheitsfehler,
    // sondern eine Endlosschleife im Render.
    admit('local', 'a', () => {})
    expect(localLaneSnapshot()).toBe(localLaneSnapshot())
  })

  it('wechselt die Identitaet, sobald sich etwas aendert', () => {
    admit('local', 'a', () => {})
    const vorher = localLaneSnapshot()
    admit('local', 'b', () => {})
    expect(localLaneSnapshot()).not.toBe(vorher)
    expect(localLaneSnapshot().queued).toEqual(['b'])
  })

  it('die leere Spur ist auch eine Momentaufnahme', () => {
    expect(localLaneSnapshot()).toEqual({ holder: null, queued: [] })
  })
})

describe('die Warteposition, die das Plaettchen anzeigt', () => {
  it('zaehlt ab eins, vorne zuerst', () => {
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    admit('local', 'c', () => {})
    expect(runQueuePosition('b')).toBe(1)
    expect(runQueuePosition('c')).toBe(2)
  })

  it('rueckt auf, wenn der Vordermann drankommt', () => {
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    admit('local', 'c', () => {})
    release('a')
    expect(runQueuePosition('c')).toBe(1)
  })

  it('GEGENPROBE: der Halter und ein Unbeteiligter haben keine', () => {
    // Der Halter rechnet. Stuende bei ihm "Platz 0", zeigte das Plaettchen
    // einen Wartenden an, der gerade arbeitet.
    admit('local', 'a', () => {})
    admit('local', 'b', () => {})
    expect(runQueuePosition('a')).toBeNull()
    expect(runQueuePosition('fremd')).toBeNull()
    expect(runQueuePosition(null)).toBeNull()
    expect(runQueuePosition(undefined)).toBeNull()
  })
})
