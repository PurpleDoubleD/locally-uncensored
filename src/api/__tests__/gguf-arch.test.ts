/**
 * Der GGUF-Kopfleser — geprueft an selbst gebauten Koepfen.
 *
 * Warum synthetisch und nicht an einer echten Datei: die kleinste GGUF im
 * Katalog ist 2 GB. Ein Test, der eine echte Datei braucht, laeuft entweder
 * nie oder haengt am Netz; beides macht ihn zu einer Behauptung. Die Koepfe
 * hier werden Byte fuer Byte nach der Spezifikation gebaut, also prueft der
 * Test genau das, was der Leser koennen muss.
 *
 * Die ECHTEN Dateien prueft der Live-Waechter nebenan
 * (katalog-architektur.live.test.ts), der nur mit LIVE_ARCH=1 laeuft.
 */
import { describe, it, expect } from 'vitest'
import { readGgufHeader, parseKnownArchitectures, parsePinnedLlamaTag } from '../gguf-arch'

// ── Ein GGUF-Kopf, Byte fuer Byte ──────────────────────────────────────────

class Bauer {
  private teile: number[] = []
  roh(...b: number[]) { this.teile.push(...b); return this }
  u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.roh(...b) }
  u64(n: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.roh(...b) }
  text(s: string) { const b = new TextEncoder().encode(s); return this.u64(b.length).roh(...b) }
  fertig() { return new Uint8Array(this.teile) }
}

/** `paare`: [Schluessel, Typ, Schreiber]. Der Schreiber legt den WERT ab. */
function kopf(paare: Array<[string, number, (b: Bauer) => void]>, opts: { version?: number; tensoren?: number; magie?: string } = {}) {
  const b = new Bauer()
  const m = new TextEncoder().encode(opts.magie ?? 'GGUF')
  b.roh(...m).u32(opts.version ?? 3).u64(opts.tensoren ?? 0).u64(paare.length)
  for (const [k, t, schreib] of paare) { b.text(k); b.u32(t); schreib(b) }
  return b.fertig()
}

const STRING = 8, ARRAY = 9, UINT32 = 4, BOOL = 7, FLOAT32 = 6

describe('readGgufHeader', () => {
  it('liest die Architektur, wenn sie der erste Schluessel ist', () => {
    const k = readGgufHeader(kopf([['general.architecture', STRING, (b) => b.text('glm-dsa')]]))
    expect(k).not.toBeNull()
    expect(k!.architecture).toBe('glm-dsa')
    expect(k!.version).toBe(3)
  })

  it('findet sie auch hinter anderen Schluesseln', () => {
    // Der Normalfall: `general.architecture` steht selten ganz vorn, und der
    // Leser muss sich an allem vorbeischieben, was davor liegt.
    const k = readGgufHeader(kopf([
      ['general.name', STRING, (b) => b.text('GLM 5.3 Flash')],
      ['general.file_type', UINT32, (b) => b.u32(15)],
      ['irgendwas.bool', BOOL, (b) => b.roh(1)],
      ['irgendwas.float', FLOAT32, (b) => b.roh(0, 0, 0, 0)],
      ['general.architecture', STRING, (b) => b.text('glm5next')],
    ]))
    expect(k!.architecture).toBe('glm5next')
  })

  it('schiebt sich an einem Zahlenfeld vorbei', () => {
    const k = readGgufHeader(kopf([
      ['tokenizer.ggml.token_type', ARRAY, (b) => { b.u32(UINT32); b.u64(3); b.u32(1); b.u32(1); b.u32(2) }],
      ['general.architecture', STRING, (b) => b.text('llama')],
    ]))
    expect(k!.architecture).toBe('llama')
  })

  it('schiebt sich an einem Textfeld vorbei — der teure Fall', () => {
    // `tokenizer.ggml.tokens` ist ein Feld mit ZEHNTAUSENDEN Zeichenketten und
    // steht in echten Dateien oft VOR der Architektur. Wer hier die Laenge
    // falsch rechnet, liest ab da nur noch Muell.
    const viele = Array.from({ length: 500 }, (_, i) => `tok${i}`)
    const k = readGgufHeader(kopf([
      ['tokenizer.ggml.tokens', ARRAY, (b) => { b.u32(STRING); b.u64(viele.length); for (const s of viele) b.text(s) }],
      ['general.architecture', STRING, (b) => b.text('qwen3')],
    ]))
    expect(k!.architecture).toBe('qwen3')
  })

  it('gibt null zurueck, wenn es keine GGUF ist', () => {
    expect(readGgufHeader(new TextEncoder().encode('<!DOCTYPE html><html>...'))).toBeNull()
    // Der Fall, der wirklich passiert: HuggingFace antwortet mit einer
    // HTML-Fehlerseite statt der Datei, und der Waechter darf das nicht als
    // "Architektur unbekannt" verbuchen, sondern als "keine GGUF".
  })

  it('lehnt Big-Endian ab, statt es falsch zu lesen', () => {
    expect(readGgufHeader(kopf([['general.architecture', STRING, (b) => b.text('x')]], { magie: 'FUGG' }))).toBeNull()
  })

  it('wirft nicht, wenn der Puffer mitten im Kopf endet', () => {
    // Der Normalfall des Waechters: wir holen absichtlich nur die ersten
    // Kilobytes einer 200-GB-Datei. Reicht es nicht bis zur Architektur, ist
    // die Antwort `null` — nicht ein Absturz und nicht eine erfundene Angabe.
    const ganz = kopf([
      ['tokenizer.ggml.tokens', ARRAY, (b) => { b.u32(STRING); b.u64(200); for (let i = 0; i < 200; i++) b.text(`tok${i}`) }],
      ['general.architecture', STRING, (b) => b.text('glm-dsa')],
    ])
    const abgeschnitten = ganz.subarray(0, 120)
    expect(() => readGgufHeader(abgeschnitten)).not.toThrow()
    expect(readGgufHeader(abgeschnitten)!.architecture).toBeNull()
  })

  it('eine erlogene Laenge liefert null, nicht eine erfundene Architektur', () => {
    // Der Fall, auf den es ankommt, und meine erste Fassung hat ihn verfehlt.
    //
    // Ich hatte hier auf "wirft nicht" geprueft und die Laengenpruefung im
    // Leser dann per Rotprobe entfernt — der Test blieb GRUEN. Grund:
    // `subarray` klemmt von sich aus auf das Pufferende, es stuerzt also
    // ohnehin nichts ab. Der Test hat eine Zeile bewacht, die er nicht
    // bewachen konnte.
    //
    // Was die Pruefung WIRKLICH verhindert, ist schlimmer als ein Absturz:
    // steht die erlogene Laenge am Wert der Architektur selbst, dekodiert der
    // Leser ohne sie den geklemmten Rest und gibt ihn als Architektur zurueck.
    // Der Live-Waechter verglichen diesen Muell dann mit llama.cpps Liste und
    // meldete "unbekannte Architektur" fuer eine Datei, die nur abgeschnitten
    // gelesen wurde — ein Fehlalarm, der einen guten Katalogeintrag blockiert.
    const b = new Bauer()
    b.roh(...new TextEncoder().encode('GGUF')).u32(3).u64(0).u64(1)
    b.text('general.architecture').u32(STRING).u64(2 ** 40).roh(1, 2, 3)
    const k = readGgufHeader(b.fertig())
    expect(() => readGgufHeader(b.fertig())).not.toThrow()
    expect(k!.architecture).toBeNull()
  })

  it('meldet die Tensorzahl mit — 0 heisst Metadaten-Shard', () => {
    // Bei mehrteiligen Modellen traegt Teil 00001 die Metadaten und NULL
    // Tensoren (bei unsloth/GLM-5.3-GGUF 9,4 MB). Das ist richtig so, aber es
    // ist gut, die Zahl zu sehen: wer sie fuer einen Fehler haelt, findet hier
    // die Erklaerung.
    const k = readGgufHeader(kopf([['general.architecture', STRING, (b) => b.text('glm-dsa')]], { tensoren: 0 }))
    expect(k!.tensorCount).toBe(0)
  })
})

describe('parseKnownArchitectures', () => {
  it('liest die Namen aus einer llama-arch.cpp', () => {
    const quelle = `
      static const std::map<llm_arch, const char *> LLM_ARCH_NAMES = {
          { LLM_ARCH_LLAMA,       "llama"       },
          { LLM_ARCH_GLM4,        "glm4"        },
          { LLM_ARCH_GLM4_MOE,    "glm4moe"     },
          { LLM_ARCH_GLM_DSA,     "glm-dsa"     },
          { LLM_ARCH_UNKNOWN,     "(unknown)"   },
      };`
    const n = parseKnownArchitectures(quelle)
    expect(n.has('glm-dsa')).toBe(true)
    expect(n.has('glm4moe')).toBe(true)
    expect(n.has('glm5next')).toBe(false)
    expect(n.size).toBe(5)
  })

  it('findet nichts in einer Datei, die keine ist — und behauptet dann auch nichts', () => {
    // Wichtig fuer den Live-Waechter: eine leere Menge muss dort "konnte nicht
    // pruefen" heissen und nicht "alle Architekturen sind unbekannt".
    expect(parseKnownArchitectures('404: Not Found').size).toBe(0)
  })
})

describe('parsePinnedLlamaTag', () => {
  it('liest den gepinnten Tag aus dem Bauskript', () => {
    expect(parsePinnedLlamaTag('LLAMA_TAG="${LLAMA_TAG:-b9949}"')).toBe('b9949')
  })

  it('gibt null, wenn die Zeile nicht mehr so aussieht', () => {
    expect(parsePinnedLlamaTag('LLAMA_TAG=b9949')).toBeNull()
  })
})
