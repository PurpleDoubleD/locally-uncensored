/**
 * Kann die Engine ueberhaupt oeffnen, was der Katalog anbietet?
 *
 * ── DIE LUECKE, DIE DIESER WAECHTER SCHLIESST ──────────────────────────────
 *
 * Der Adress-Waechter nebenan (hf-catalog-addresses.live.test.ts) prueft, ob es
 * die Datei gibt, der Groessen-Waechter (bundle-size-drift.live.test.ts), ob sie
 * so gross ist wie versprochen. Beide sagen selbst, was sie NICHT koennen:
 * "dass die Datei hinter der Adresse die richtige ist".
 *
 * Am 02.09.2026 wurde daraus ein konkreter Fall. GLM 5.3 sollte in den Katalog.
 * Beide Varianten stehen in der Cloud und funktionieren dort, GGUFs gibt es fuer
 * beide, die Adressen antworten mit 200, die Groessen stimmen — beide vorhandenen
 * Waechter haetten alles durchgewinkt. Aus den Kopfbytes gelesen:
 *
 *   unsloth/GLM-5.3-GGUF                        glm-dsa    → llama.cpp kennt sie
 *   unsloth/GLM-5.3-Flash-GGUF                  glm5next   → kennt sie NICHT
 *   AliceThirty/GLM-5.3-Flash-UNCENSORED-GGUF   glm5next   → kennt sie NICHT
 *   darask0/GLM-5.3-Flash-UNCENSORED-GGUF       glm5next   → kennt sie NICHT
 *
 * Ein Eintrag fuer GLM 5.3 Flash haette also hunderte Gigabyte geladen, jede
 * Pruefung bestanden — und die Engine haette die Datei danach nicht oeffnen
 * koennen. Der Nutzer erfaehrt es als Erster, nach dem Download.
 *
 * ── WIE ER PRUEFT ──────────────────────────────────────────────────────────
 *
 * Er holt die ersten 400 KB jeder Textmodell-GGUF (ein Range-Request, keine
 * Nutzdaten) und liest `general.architecture`. Die Gegenliste kommt aus dem
 * llama.cpp-Quelltext des Tags, den `scripts/build-llama.sh` WIRKLICH baut —
 * nicht aus einer gepflegten Liste, denn die waere genau nach einem
 * llama.cpp-Sprung falsch, also genau dann, wenn es zaehlt.
 *
 * ── WARUM NICHT catalogAddresses() ─────────────────────────────────────────
 *
 * Die erste Fassung lief ueber `catalogAddresses()`, und der erste Lauf brachte
 * sechs Funde — vier davon falsch:
 *
 *   wan     nsfw_wan_14b_e15_q4_k.gguf, Wan2.2-S2V-14B, Wan2.2-Animate-14B,
 *           wan2.2-i2v-rapid-aio-v10
 *   hy_v3   Hy3-Q4_K_M.gguf, Hy3-IQ1_M.gguf
 *
 * Die vier `wan`-Dateien sind GGUFs, aber keine Sprachmodelle: sie liegen in
 * `subfolder: 'diffusion_models'` und werden von ComfyUI-GGUF geladen, nie von
 * llama.cpp. Dass llama.cpp `wan` nicht kennt, ist richtig so und kein Fund.
 * `catalogEntries()` sagt es selbst: "image/video bundles and text models
 * alike. One walk" — praktisch fuer Adressen, falsch fuer diese Frage.
 *
 * Deshalb laeuft dieser Waechter ueber die zwei Listen, die WIRKLICH bei
 * llama.cpp landen, und nur ueber sie. Ein Waechter, der vier von sechs Malen
 * daneben liegt, wird beim naechsten Mal weggeklickt — und dann faellt der eine
 * echte Fund mit weg.
 *
 * `mmprojUrl` bleibt ebenfalls aussen vor: ein Vision-Projektor traegt eine
 * Projektor-Architektur und wird von mtmd geoeffnet, nicht ueber die
 * LLM_ARCH_NAMES-Tabelle.
 *
 * ── WAS ER NICHT BEWEIST ───────────────────────────────────────────────────
 *
 * Dass das Modell laeuft. Eine bekannte Architektur kann trotzdem an einem zu
 * neuen Tensor-Layout scheitern, und die Engine kann am Speicher scheitern. Er
 * beweist genau eine Sache, dafuer sicher: dass die Architektur der Datei in der
 * Liste steht, die der gebaute llama.cpp kennt. Das ist die Huerde, an der GLM
 * 5.3 Flash gescheitert waere.
 *
 * Netzabhaengig, deshalb nur mit LIVE_ARCH=1 und nicht im normalen Gate:
 *
 *   LIVE_ARCH=1 npx vitest run src/api/__tests__/katalog-architektur.live.test.ts
 */
import { describe, it, expect } from 'vitest'
import { getUncensoredTextModels, getMainstreamTextModels } from '../discover'
import { readGgufHeader, parseKnownArchitectures, parsePinnedLlamaTag } from '../gguf-arch'
import { istBekanntTot } from './hf-live-probe'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIVE = process.env.LIVE_ARCH === '1'
const here = dirname(fileURLToPath(import.meta.url))
const wurzel = resolve(here, '../../..')

/** 400 KB reichen: `general.architecture` steht in jeder gesehenen Datei davor. */
const KOPF_BYTES = 400_000
const PARALLEL = 4
const TIMEOUT_MS = 90_000

interface Befund {
  url: string
  wo: string[]
  arch: string | null
  fehler?: string
}

async function holeKopf(url: string): Promise<Uint8Array | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      headers: { Range: `bytes=0-${KOPF_BYTES - 1}` },
      signal: ac.signal,
      redirect: 'follow',
    })
    if (!r.ok) return null
    return new Uint8Array(await r.arrayBuffer())
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** Die Architekturen, die der GEBAUTE llama.cpp kennt. Leer = konnte nicht laden. */
async function bekannteArchitekturen(): Promise<{ tag: string | null; namen: Set<string> }> {
  const skript = readFileSync(resolve(wurzel, 'scripts/build-llama.sh'), 'utf8')
  const tag = parsePinnedLlamaTag(skript)
  if (!tag) return { tag: null, namen: new Set() }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${tag}/src/llama-arch.cpp`, { signal: ac.signal })
    if (!r.ok) return { tag, namen: new Set() }
    return { tag, namen: parseKnownArchitectures(await r.text()) }
  } catch {
    return { tag, namen: new Set() }
  } finally {
    clearTimeout(t)
  }
}

async function inHaeppchen<T, R>(werte: T[], n: number, f: (v: T) => Promise<R>): Promise<R[]> {
  const raus: R[] = []
  for (let i = 0; i < werte.length; i += n) {
    raus.push(...await Promise.all(werte.slice(i, i + n).map(f)))
  }
  return raus
}

describe.runIf(LIVE)('Katalog-Architekturen gegen das, was llama.cpp kann', () => {
  it('jede GGUF im Katalog traegt eine Architektur, die der gebaute llama.cpp kennt', async () => {
    const { tag, namen } = await bekannteArchitekturen()
    expect(tag, 'LLAMA_TAG steht nicht mehr wie erwartet in scripts/build-llama.sh').not.toBeNull()
    // Eine leere Liste heisst "konnte nicht pruefen" und NICHT "alle unbekannt".
    // Ohne diese Zeile meldete der Waechter bei einem GitHub-Ausfall den ganzen
    // Katalog als kaputt — die teuerste Art, ein Gate unglaubwuerdig zu machen.
    expect(namen.size, `llama-arch.cpp von Tag ${tag} war nicht ladbar — kein Urteil moeglich`).toBeGreaterThan(20)

    // Nur die Modelle, die der gebaute llama.cpp wirklich oeffnet. Doppelte
    // Adressen (ein Repo, mehrere Eintraege) werden zusammengefasst, damit ein
    // Fund einmal gemeldet wird und alle Namen mitbringt.
    const proUrl = new Map<string, Set<string>>()
    for (const m of [...getUncensoredTextModels(), ...getMainstreamTextModels()]) {
      const url = m.downloadUrl
      if (!url || !url.endsWith('.gguf') || istBekanntTot(url)) continue
      const wo = m.filename ? `${m.name} · ${m.filename}` : m.name
      const gesehen = proUrl.get(url)
      if (gesehen) gesehen.add(wo)
      else proUrl.set(url, new Set([wo]))
    }
    const ggufs = [...proUrl].map(([url, wo]) => ({ url, where: [...wo] }))
    expect(ggufs.length).toBeGreaterThan(0)

    const befunde: Befund[] = await inHaeppchen(ggufs, PARALLEL, async (a) => {
      const buf = await holeKopf(a.url)
      if (!buf) return { url: a.url, wo: a.where, arch: null, fehler: 'Kopf nicht ladbar' }
      const kopf = readGgufHeader(buf)
      if (!kopf) return { url: a.url, wo: a.where, arch: null, fehler: 'keine GGUF (HTML? gated?)' }
      return { url: a.url, wo: a.where, arch: kopf.architecture }
    })

    // `arch: null` ist KEIN Fehlurteil: es heisst "konnte nicht lesen", und
    // dafuer gibt es die Waechter nebenan. Nur eine GELESENE, aber unbekannte
    // Architektur ist ein Befund — das ist der Fall, den niemand sonst sieht.
    const unbekannt = befunde.filter((b) => b.arch !== null && !namen.has(b.arch))
    const ungelesen = befunde.filter((b) => b.arch === null)

    if (ungelesen.length > 0) {
      console.log(`[Architektur-Waechter] ${ungelesen.length} Dateien nicht lesbar (kein Urteil):`)
      for (const b of ungelesen.slice(0, 10)) console.log(`  ${b.fehler}  ${b.url}`)
    }
    console.log(`[Architektur-Waechter] llama.cpp @ ${tag} kennt ${namen.size} Architekturen · ${befunde.length - ungelesen.length} von ${befunde.length} GGUFs gelesen`)

    const zeilen = unbekannt.map((b) =>
      `  general.architecture "${b.arch}" kennt llama.cpp @ ${tag} NICHT\n`
      + `      ${b.url}\n`
      + `      genannt von: ${b.wo.join(', ')}`)

    expect(
      zeilen,
      zeilen.length
        ? `Diese Katalogeintraege laedt der Nutzer herunter und kann sie dann nicht oeffnen:\n${zeilen.join('\n')}\n`
          + `\nEntweder den Eintrag entfernen, oder LLAMA_TAG in scripts/build-llama.sh auf einen Stand heben, der die Architektur kennt.`
        : undefined,
    ).toEqual([])
  }, 20 * 60_000)
})

describe.runIf(LIVE)('Die Gegenliste selbst', () => {
  it('llama.cpp am gepinnten Tag kennt die Architekturen, auf die der Katalog baut', async () => {
    // Gegenprobe zum Test oben: der koennte auch dadurch gruen sein, dass die
    // Liste versehentlich ALLES enthaelt. Diese vier sind im Katalog belegt.
    const { tag, namen } = await bekannteArchitekturen()
    for (const a of ['llama', 'qwen3', 'gemma3', 'glm4moe']) {
      expect(namen.has(a), `${a} fehlt in llama-arch.cpp @ ${tag}`).toBe(true)
    }
    // Und die eine, die es am 02.09.2026 NICHT gab. Faellt diese Zusicherung,
    // ist das eine gute Nachricht: dann kann GLM 5.3 Flash lokal laufen und
    // gehoert in den Katalog. Sie steht hier, damit es jemand merkt.
    expect(
      namen.has('glm5next'),
      `glm5next ist jetzt in llama.cpp @ ${tag} — GLM 5.3 Flash kann lokal laufen und sollte in den Katalog (siehe PRs #27752, #27754, #27773).`,
    ).toBe(false)
  }, 3 * 60_000)
})
