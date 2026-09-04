/**
 * Ein abgelehnter Arbeitsordner darf nicht still durchgehen.
 *
 * Der Fernauftrag laesst den Nutzer einen Ordner waehlen und bindet ihn ueber
 * `set_chat_workspace_override` an das Gespraech `__remote__`. Seit 2.6.8
 * prueft die Rust-Seite dabei gegen eine Verbotsliste
 * (`agent.rs:636` ruft `validate_workspace_root`), die unter anderem $HOME
 * genau, `/`, `/etc`, `~/.ssh` und `C:\Windows` ablehnt. Auf v2.6.7 gab es
 * diese Pruefung nicht, jeder nicht-leere Pfad wurde genommen.
 *
 * Die Oberflaeche hat den Fehler mit einem LEEREN catch gefangen, Kommentar
 * "Override is a nice-to-have", und den Auftrag trotzdem losgeschickt. Zwei
 * Folgen, und die zweite ist die ernstere:
 *
 *  1. Der Nutzer erfaehrt nicht, dass sein Ordner abgelehnt wurde.
 *  2. Der `else`-Zweig, der eine alte Bindung raeumt, laeuft im
 *     Ablehnungsfall NICHT. Steht in `chat_workspace_overrides` noch der
 *     Ordner eines frueheren Dispatchs derselben App-Sitzung, arbeitet der
 *     Agent WEITER IM ALTEN ORDNER, waehrend der Nutzer glaubt, er habe
 *     gerade einen anderen gewaehlt. `remoteStore` raeumt zwar beim Beenden
 *     auf, aber zwei Dispatches ohne Beenden dazwischen genuegen.
 *
 * Das war der einzige der drei Update-Funde vom 04.09.2026, der wirklich
 * lautlos ist. Ein stiller Fehlschlag auf einem Weg, der Dateien schreibt,
 * ist genau die Sorte, die erst beim Kunden auffaellt und dann ohne Spur.
 *
 * Quelltextrechnung, weil `vitest.config.ts` mit environment 'node' laeuft und
 * es keinen Renderer gibt. Der TEXT der Meldung wird dagegen echt geprueft,
 * er ist eine reine Funktion.
 *
 * Lauf: npx vitest run src/components/layout/__tests__/der-abgelehnte-ordner-wird-nicht-verschluckt.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { workspaceRejectedMessage } from '../../../lib/workspace-rejected'

/** Der Inhalt eines Blocks ab seiner oeffnenden Klammer, Klammern gezaehlt. */
function klammerBlock(text: string, auf: number): string {
  let tiefe = 0
  for (let i = auf; i < text.length; i++) {
    if (text[i] === '{') tiefe++
    else if (text[i] === '}') {
      tiefe--
      if (tiefe === 0) return text.slice(auf, i + 1)
    }
  }
  return text.slice(auf)
}

const sidebar = () => {
  const roh = readFileSync(resolve(__dirname, '..', 'Sidebar.tsx'), 'utf8')
  // Der Ausschnitt um die Bindung herum, damit ein leeres catch woanders in
  // der Datei diesen Test nicht faelschlich rot macht.
  const i = roh.indexOf("set_chat_workspace_override")
  expect(i, 'die Bindung an __remote__ ist aus Sidebar.tsx verschwunden').toBeGreaterThan(0)
  return roh.slice(i - 400, i + 2200)
}

describe('die Ablehnung wird gemeldet statt verschluckt', () => {
  it('das catch um die Bindung ist nicht mehr leer', () => {
    const stelle = sidebar()
    // Vorher stand hier woertlich:
    //   } catch {
    //     // Override is a nice-to-have - fall through and dispatch anyway.
    //   }
    expect(stelle, 'das leere catch ist zurueck').not.toMatch(/catch\s*\{\s*\/\/[^\n]*nice-to-have/)
    expect(stelle, 'die Ablehnung erreicht den Nutzer nicht').toContain('workspaceRejectedMessage')
  })

  it('eine alte Bindung wird im Ablehnungsfall geraeumt', () => {
    const stelle = sidebar()
    // `path: null` muss im Fehlerzweig stehen, nicht nur im else-Zweig fuer
    // "gar nichts gewaehlt". Gezaehlt wird, weil genau EINE Fundstelle der
    // alte, halbe Zustand waere.
    const raeumungen = stelle.match(/path:\s*null/g) ?? []
    expect(raeumungen.length, 'path: null steht nur einmal, der Fehlerzweig raeumt also nicht')
      .toBeGreaterThanOrEqual(2)
  })

  it('der Auftrag faehrt nicht trotzdem los', () => {
    // Der Nutzer hat einen Ordner gewaehlt. Ihn stattdessen still in der
    // Sandbox arbeiten zu lassen waere wieder eine stille Abweichung, nur eine
    // andere. Abgebrochen wird wie beim Abbrechen des Dialogs darueber.
    //
    // Gesucht wird ab der Bindung selbst, nicht ab dem ersten `catch` im
    // Ausschnitt: darueber steht das catch von `pick_folder`, und das faengt
    // etwas anderes (kein Tauri im Browser) und darf gerade NICHT abbrechen.
    // Beim ersten Anlauf hat dieser Test genau daran gemessen und den Fix
    // faelschlich fuer fehlend gehalten.
    //
    // Gemessen wird NUR im catch-Block, nicht in einem Fenster fester Groesse
    // dahinter. Beim zweiten Anlauf hat dieser Test ein `return` aus dem Code
    // WEITER UNTEN gefunden und blieb bei zurueckgebautem Fix gruen. Eine
    // Wache, die den Rueckbau ueberlebt, ist keine.
    const stelle = sidebar()
    const bindung = stelle.indexOf("path: pickedFolder")
    expect(bindung, 'die Bindung mit dem gewaehlten Pfad ist weg').toBeGreaterThan(0)
    const catchAuf = stelle.indexOf('catch', bindung)
    expect(catchAuf, 'kein catch nach der Bindung').toBeGreaterThan(0)
    const block = klammerBlock(stelle, stelle.indexOf('{', catchAuf))
    expect(block, 'der Fehlerzweig kehrt nicht zurueck').toMatch(/\breturn\b/)
    expect(block, 'der Fehlerzweig raeumt die alte Bindung nicht').toMatch(/path:\s*null/)
  })
})

describe('der Satz, den der Nutzer liest', () => {
  it('nennt den Ordner und den Grund, auf Englisch', () => {
    const satz = workspaceRejectedMessage('/Users/someone', new Error('workspace root is not allowed'))
    expect(satz).toContain('/Users/someone')
    expect(satz).toContain('workspace root is not allowed')
    // Hausregel: Fehlermeldungen sind Englisch.
    expect(satz).not.toMatch(/[äöüß]|Ordner|nicht/)
  })

  it('sagt auch, was jetzt gilt, nicht nur was schiefging', () => {
    // Ohne diesen Halbsatz bliebe offen, ob der Auftrag trotzdem laeuft.
    const satz = workspaceRejectedMessage('/etc', new Error('x')).toLowerCase()
    expect(satz).toMatch(/not dispatched|nothing was started|no folder is bound/)
  })

  it('kommt auch mit einem Wurf ohne Nachricht zurecht', () => {
    // backendCall wirft nicht immer ein Error-Objekt.
    const satz = workspaceRejectedMessage('/etc', 'plain string')
    expect(satz).toContain('/etc')
    expect(satz.length).toBeGreaterThan(20)
  })
})
