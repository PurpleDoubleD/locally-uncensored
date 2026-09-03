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

// ── Die Nachsuche vom 02.09.2026 ────────────────────────────────────────────
//
// „such mehr nach uncensored, irgendwas muss es geben" — es gab etwas, aber
// nicht bei GLM. Diese drei Modelle standen unter den zehn meistgeladenen
// unzensierten GGUF-Modellen und fehlten im Katalog. Der Test haelt fest,
// WELCHE Datei jeweils gemeint ist, denn bei zweien ist die naheliegende die
// falsche.

describe('was die Nachsuche gebracht hat, bleibt drin', () => {
  const alle = getUncensoredTextModels()

  it('Qwen 3.8 27B Heretic zeigt auf RVN, nicht auf die Altdatei', () => {
    const gruppe = alle.filter((m) => m.group === 'Qwen 3.8 27B Heretic')
    expect(gruppe.length).toBe(4)
    for (const m of gruppe) {
      // Die Modellkarte sagt ausdruecklich, dass
      // `Qwen3.8-27B-Heretic-Q4_K_M.gguf` die AELTERE Abliteration ist und nur
      // "for download-count continuity" liegen bleibt. Wer sie versehentlich
      // eintraegt, liefert dem Nutzer das schwaechere Modell aus, und niemand
      // sieht es an der Datei.
      expect(m.filename).toMatch(/^RVN-.*-multilingual\.gguf$/)
      // MTP- und Vision-Sonderbauten sind bewusst draussen, solange sie
      // niemand am Pin gefahren hat.
      expect(m.filename).not.toContain('mtp')
      expect(m.filename).not.toContain('-vision')
      // Vision kommt ueber den Projektor, nicht ueber eine Sondervariante.
      expect(m.mmprojUrl).toBeTruthy()
    }
  })

  it('Gemma 4 und Qwen3-VL fuellen die zwei echten Luecken', () => {
    // Gemma: alles Unzensierte hier war Qwen oder GLM.
    const gemma = alle.filter((m) => m.group === 'Gemma 4 12B Heretic')
    expect(gemma.length).toBe(3)
    expect(gemma.every((m) => m.mmprojUrl)).toBe(true)

    // Qwen3-VL: unzensiertes Bildverstehen gab es erst ab 27B, also nicht auf
    // einer 8-GB-Karte. Genau das ist der Zweck dieses Eintrags — faellt die
    // Groesse, faellt der Grund.
    const vl = alle.filter((m) => m.group === 'Qwen3-VL 8B Abliterated')
    expect(vl.length).toBe(3)
    expect(vl.every((m) => m.mmprojUrl)).toBe(true)
    const klein = vl.find((m) => m.filename?.includes('Q4_K_M'))
    expect(klein?.sizeGB).toBeLessThanOrEqual(6)
  })
})
