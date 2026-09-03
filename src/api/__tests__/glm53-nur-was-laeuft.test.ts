/**
 * GLM 5.3 im Katalog — und warum Flash NICHT drinsteht.
 *
 * ── DER AUFTRAG UND DER BEFUND ─────────────────────────────────────────────
 *
 * Auftrag am 02.09.2026: "wir haben GLM 5.3 Flash und das normale in Cloud
 * uebernommen, bau das bitte fuer die Ollama, LM Studio und LU Engine sauber in
 * den Model Manager, alle die du finden kannst mit uncensored versionen".
 *
 * Gemessen wurde daraufhin, was ueberhaupt laufen KANN. Aus den GGUF-Kopfbytes
 * (api/gguf-arch.ts, ein zweiter unabhaengiger Leser in Python gegengeprueft):
 *
 *   unsloth/GLM-5.3-GGUF                        glm-dsa
 *   unsloth/GLM-5.3-Flash-GGUF                  glm5next
 *   qtum, DevQuasar, Blackfrost (Flash)         glm5next
 *   antirez, AesSedai (Flash)                   glm5-next
 *   BoldingBuilds (Flash, uncensored)           glm5next
 *
 * Die zwei Schreibweisen sind ein Konvertier-Artefakt, kein Tippfehler. Beide
 * kennt llama.cpp nicht — nicht am gepinnten Tag und nicht auf master. Vier
 * PRs offen (#27752, #27754, #27773, #27917), keiner gemergt.
 *
 * Uncensored gibt es GLM 5.3 nur als Flash (AliceThirty, darask0, orcarouter,
 * Blackfrost "DERISKED", MorinoNushi "Heretic") — also genau in der Variante,
 * die lokal nicht laeuft. Fuer die grosse existiert uncensored nur als NVFP4
 * und FP8 (dealignai), und das sind vLLM-Formate, keine GGUF.
 *
 * Ollama fuehrt `glm-5.3` und `glm-5.3-flash` ausschliesslich als `:cloud`,
 * ohne lokale Gewichte. Ein `ollamaModel`-Eintrag dafuer verspraeche in einer
 * App namens Locally Uncensored etwas, das auf fremden Rechnern rechnet.
 *
 * ── WARUM DAS EINE SPERRE BRAUCHT UND NICHT NUR EINEN KOMMENTAR ────────────
 *
 * Weil der naechste Mensch genau dieselbe Suche macht, dieselben Repos findet,
 * 200 antwortende Adressen sieht und den Eintrag hinschreibt. Alle vorhandenen
 * Waechter winken ihn durch: die Adresse lebt, die Groesse stimmt. Erst der
 * Nutzer merkt es — nach dem Download.
 *
 * Diese Sperre ist deshalb kein Verbot auf Dauer, sondern eine Handbremse:
 * wird sie rot, weil jemand Flash eintraegt, gehoert vorher
 * `LIVE_ARCH=1 npx vitest run src/api/__tests__/katalog-architektur.live.test.ts`
 * gelaufen. Sagt der gruen, ist llama.cpp weiter und der Eintrag richtig — dann
 * faellt diese Datei, nicht der Eintrag.
 */
import { describe, it, expect } from 'vitest'
import { getUncensoredTextModels, getMainstreamTextModels } from '../discover'

const alle = () => [...getUncensoredTextModels(), ...getMainstreamTextModels()]

describe('GLM 5.3 steht im Katalog', () => {
  it('die grosse Variante ist da, mehrteilig, aus dem glm-dsa-Repo', () => {
    const glm53 = alle().filter((m) => m.name.startsWith('GLM 5.3'))
    expect(glm53.length).toBeGreaterThanOrEqual(2)
    for (const m of glm53) {
      // Genau dieses Repo traegt glm-dsa. Ein anderes Repo kann alles tragen.
      expect(m.downloadUrl).toContain('unsloth/GLM-5.3-GGUF')
      expect(m.filename).toMatch(/-00001-of-000\d\d\.gguf$/)
      // Ohne diese Marke sieht der Nutzer im Bestaetigungsdialog nicht, dass
      // hinter dem einen Namen sechs oder sieben Dateien haengen.
      expect(m.tags).toContain('Multi-part')
      expect(m.sizeGB).toBeGreaterThan(200)
    }
  })
})

describe('GLM 5.3 Flash steht NICHT im Katalog', () => {
  it('kein Eintrag zeigt auf ein Flash-GGUF', () => {
    const flash = alle().filter((m) => /5\.3.?flash/i.test(`${m.name} ${m.downloadUrl ?? ''}`))
    expect(
      flash.map((m) => `${m.name} → ${m.downloadUrl}`),
      'GLM 5.3 Flash traegt glm5next/glm5-next; llama.cpp kennt beides nicht. '
      + 'Vor dem Eintragen: LIVE_ARCH=1 npx vitest run src/api/__tests__/katalog-architektur.live.test.ts',
    ).toEqual([])
  })

  it('kein Eintrag zieht GLM 5.3 ueber einen Ollama-Cloud-Tag herein', () => {
    // ollama.com/library/glm-5.3 und /glm-5.3-flash haben nur `:cloud`.
    // Ein Eintrag hier waere ein lokales Versprechen mit fremder Rechnung.
    const ollama = alle()
      .filter((m) => m.ollamaModel && /glm-?5\.3/i.test(m.ollamaModel))
      .map((m) => `${m.name} → ${m.ollamaModel}`)
    expect(ollama).toEqual([])
  })
})
