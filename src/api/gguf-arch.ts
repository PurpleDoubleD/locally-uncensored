/**
 * Welche Architektur steht im Kopf einer GGUF-Datei?
 *
 * ── WARUM DAS EINE EIGENE DATEI IST ────────────────────────────────────────
 *
 * Am 02.09.2026 sollte GLM 5.3 in den Katalog. Beide Varianten sind in der
 * Cloud eingetragen und funktionieren dort, GGUFs gibt es fuer beide, die
 * Adressen antworten mit 200, die Groessen stimmen — der Adress-Waechter
 * nebenan (hf-catalog-addresses.live.test.ts) haette sie alle durchgewinkt.
 * Er sagt das sogar selbst: "Was er NICHT beweist: dass die Datei hinter der
 * Adresse die richtige ist."
 *
 * Gemessen habe ich dann die Kopfbytes:
 *
 *   unsloth/GLM-5.3-GGUF              general.architecture = glm-dsa
 *   unsloth/GLM-5.3-Flash-GGUF        general.architecture = glm5next
 *   AliceThirty/…-Flash-UNCENSORED    general.architecture = glm5next
 *   darask0/…-Flash-UNCENSORED        general.architecture = glm5next
 *
 * Und llama.cpp kennt — auf master WIE auf dem hier gepinnten Tag — genau
 * vier GLM-Architekturen: chatglm, glm-dsa, glm4, glm4moe. `glm5next` ist
 * nicht dabei; vier PRs dazu waren an dem Tag offen und keiner gemergt.
 *
 * Ein Katalogeintrag fuer GLM 5.3 Flash haette also hunderte Gigabyte geladen,
 * alle Pruefungen bestanden — und die Engine haette die Datei danach nicht
 * oeffnen koennen. Das ist die teuerste Art, einen Nutzer zu enttaeuschen, und
 * keine der vorhandenen Sperren sieht sie.
 *
 * ── WAS HIER STEHT UND WAS NICHT ───────────────────────────────────────────
 *
 * Nur das Lesen des Kopfes, als reine Funktion ueber einem Puffer. Das Holen
 * der ersten Bytes und der Vergleich mit dem, was llama.cpp kann, stehen im
 * Live-Waechter (__tests__/katalog-architektur.live.test.ts) — weil das Netz
 * braucht und diese Datei nicht.
 *
 * Format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 *   "GGUF" · version u32 · tensor_count u64 · kv_count u64 · dann die Paare.
 * Alles Little-Endian; ein Big-Endian-GGUF traegt die Magie "FUGG" und wird
 * hier abgelehnt statt falsch gelesen.
 */

/**
 * Die Typkennungen aus der GGUF-Spezifikation.
 *
 * Ein Objekt und kein `const enum`: die tsconfig dieses Hauses steht auf
 * `erasableSyntaxOnly`, und ein `const enum` erzeugt Code statt zu verschwinden.
 */
const Typ = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const

/** Feste Breite je Typ. STRING und ARRAY fehlen absichtlich — sie sind variabel. */
const BREITE: Record<number, number> = {
  [Typ.UINT8]: 1, [Typ.INT8]: 1, [Typ.UINT16]: 2, [Typ.INT16]: 2,
  [Typ.UINT32]: 4, [Typ.INT32]: 4, [Typ.FLOAT32]: 4, [Typ.BOOL]: 1,
  [Typ.UINT64]: 8, [Typ.INT64]: 8, [Typ.FLOAT64]: 8,
}

export interface GgufKopf {
  version: number
  tensorCount: number
  /** `general.architecture`, oder null wenn sie im gelesenen Fenster nicht kam. */
  architecture: string | null
}

/**
 * Liest den Anfang einer GGUF-Datei.
 *
 * Gibt `null` zurueck, wenn der Puffer keine GGUF ist. Wirft NIE: ein
 * abgeschnittener Puffer (wir lesen absichtlich nur die ersten Bytes einer
 * 200-GB-Datei) endet in `architecture: null`, nicht in einem Absturz. Genau
 * dieser Fall ist der Normalfall, wenn zu wenig geholt wurde.
 */
export function readGgufHeader(buf: Uint8Array): GgufKopf | null {
  if (buf.length < 24) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magie = String.fromCharCode(buf[0], buf[1], buf[2], buf[3])
  if (magie !== 'GGUF') return null

  const version = dv.getUint32(4, true)
  const tensorCount = Number(dv.getBigUint64(8, true))
  const kvCount = Number(dv.getBigUint64(16, true))
  let off = 24

  /** Nur lesen, was wirklich da ist. `false` heisst: Puffer zu Ende. */
  const passt = (n: number) => off + n <= buf.length

  const leseText = (): string | null => {
    if (!passt(8)) return null
    const laenge = Number(dv.getBigUint64(off, true))
    off += 8
    if (laenge < 0 || !passt(laenge)) return null
    const s = new TextDecoder('utf-8').decode(buf.subarray(off, off + laenge))
    off += laenge
    return s
  }

  /** Ueberspringt einen Wert des gegebenen Typs. `false` = Puffer zu Ende. */
  const ueberspringe = (typ: number, tiefe = 0): boolean => {
    if (typ === Typ.STRING) return leseText() !== null
    if (typ === Typ.ARRAY) {
      // Verschachtelte Felder sind laut Spezifikation moeglich. Die Tiefe ist
      // begrenzt, damit eine beschaedigte Datei hier nicht endlos absteigt.
      if (tiefe > 8 || !passt(12)) return false
      const elemTyp = dv.getUint32(off, true); off += 4
      const anzahl = Number(dv.getBigUint64(off, true)); off += 8
      if (anzahl < 0) return false
      if (elemTyp === Typ.STRING || elemTyp === Typ.ARRAY) {
        for (let i = 0; i < anzahl; i++) if (!ueberspringe(elemTyp, tiefe + 1)) return false
        return true
      }
      const b = BREITE[elemTyp]
      if (b === undefined) return false
      if (!passt(b * anzahl)) return false
      off += b * anzahl
      return true
    }
    const b = BREITE[typ]
    if (b === undefined) return false
    if (!passt(b)) return false
    off += b
    return true
  }

  for (let i = 0; i < kvCount; i++) {
    const schluessel = leseText()
    if (schluessel === null) break
    if (!passt(4)) break
    const typ = dv.getUint32(off, true)
    off += 4
    if (schluessel === 'general.architecture') {
      if (typ !== Typ.STRING) break
      const wert = leseText()
      return { version, tensorCount, architecture: wert }
    }
    if (!ueberspringe(typ)) break
  }
  return { version, tensorCount, architecture: null }
}

/**
 * Die Architekturnamen, die eine llama-arch.cpp kennt.
 *
 * Gelesen aus dem Quelltext statt aus einer gepflegten Liste, weil eine
 * gepflegte Liste genau dann falsch ist, wenn es darauf ankommt: nach einem
 * llama.cpp-Sprung. Der Waechter holt die Datei vom GEPINNTEN Tag, also von
 * dem Stand, den `scripts/build-llama.sh` wirklich baut.
 *
 * Gesucht werden die Zeilen der Form `{ LLM_ARCH_XXX, "name" }`.
 */
export function parseKnownArchitectures(llamaArchCpp: string): Set<string> {
  const namen = new Set<string>()
  const re = /\{\s*LLM_ARCH_[A-Z0-9_]+\s*,\s*"([^"]+)"\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(llamaArchCpp)) !== null) namen.add(m[1])
  return namen
}

/** Der in scripts/build-llama.sh gepinnte llama.cpp-Tag. */
export function parsePinnedLlamaTag(buildScript: string): string | null {
  const m = /LLAMA_TAG="\$\{LLAMA_TAG:-([^}"]+)\}"/.exec(buildScript)
  return m ? m[1] : null
}
