/**
 * Was die verbreiteten OpenAI-kompatiblen Server ueber ihr Kontextfenster
 * verraten, und wie man es aus ihrer Antwort liest.
 *
 * Bis GH #129 kannte die Kaskade zwei Wege: die erweiterte LM-Studio-API und
 * ein allgemeines `/v1/models/<id>`. Ein llama.cpp `llama-server`, ein vLLM
 * und ein KoboldCpp beantworten die Frage alle, nur an anderen Stellen, und
 * der Melder aus #129 betreibt genau so einen Server. Ohne diese Wege blieb
 * nur `guessContextFromName`, und dessen 8192 landete als erfundene Zahl im
 * Zaehler UND als `max_tokens` auf der Leitung.
 *
 * Jede Funktion hier ist REIN: sie bekommt einen schon geparsten JSON-Koerper
 * und gibt eine Zahl oder null zurueck. Das Netz liegt beim Aufrufer
 * (openai-provider.ts), die Auswertung liegt hier und ist damit ohne Server
 * pruefbar. Belegt sind die Endpunkte gegen die Dokumentation der Server,
 * nicht gegen eine laufende Maschine: hier laeuft keiner.
 *
 * Jede Quelle liefert deshalb ZWEI Zahlen getrennt: das laufende Fenster und
 * die Decke, mit der ein Modell hoechstens koennte. Nur die erste beschreibt
 * den Server, der gerade antwortet; die zweite ist eine Eigenschaft des
 * Modells und sagt ueber diesen Lauf nichts. Wer beide in ein Feld legt,
 * bekommt genau den Fall aus der Box vom 11.09.2026: ein llama-server mit
 * `--ctx-size 16384` wurde als 40960 angezeigt und bekam ein `max_tokens`
 * ueber seinem gesamten Fenster.
 *
 * Die Endpunkte:
 *   llama.cpp llama-server  GET /props
 *                           -> default_generation_settings.n_ctx (GELADEN)
 *   llama.cpp llama-server  GET /v1/models
 *                           -> data[].meta.n_ctx       (GELADEN)
 *                           -> data[].meta.n_ctx_train (TRAINIERT)
 *   vLLM                    GET /v1/models -> data[].max_model_len (GELADEN)
 *   KoboldCpp               GET /api/extra/true_max_context_length -> { value }
 *   LM Studio               GET /api/v0/models/<id>
 *                           -> loaded_context_length (GELADEN)
 *                           -> max_context_length    (TRAINIERT)
 */

import { isRecord, prop, asNumber } from './wire'

/**
 * Die Wurzel des Servers, aus der Basis-URL abgeleitet.
 *
 * `http://localhost:8080/v1` und `http://localhost:8080` sind derselbe
 * Server; die zweite Schreibweise ist die, mit der llama-server in seiner
 * eigenen Anleitung startet. Der alte Code schnitt `/v1` nur ab, wenn es da
 * war, und WEIGERTE sich sonst zu fragen (`if (base === this.baseUrl) return
 * null`), womit die haeufigere der beiden Schreibweisen nie geprueft wurde.
 */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Die `/v1`-Wurzel desselben Servers, egal wie die Basis geschrieben war. */
export function v1Root(baseUrl: string): string {
  return `${serverRoot(baseUrl)}/v1`
}

/**
 * llama.cpp `GET /props`.
 *
 * `default_generation_settings.n_ctx` ist der Kontext, den dieser Server
 * WIRKLICH je Slot geladen hat (`-c` geteilt durch `--parallel`), also die
 * ehrliche Zahl fuer den Zaehler. Ein Prompt darueber wird serverseitig
 * abgeschnitten oder abgelehnt, und genau das bekam der Melder als "token
 * limit exceeded" zu sehen.
 *
 * Aeltere Bauten legen dieselbe Zahl nach `default_generation_settings.params`,
 * deshalb wird beides gelesen; `n_ctx` auf oberster Ebene ist die dritte
 * Schreibweise, die im Umlauf ist.
 */
export function parseLlamaCppProps(body: unknown): number | null {
  if (!isRecord(body)) return null
  const settings = prop(body, 'default_generation_settings')
  const fromSettings =
    asNumber(prop(settings, 'n_ctx')) ?? asNumber(prop(prop(settings, 'params'), 'n_ctx'))
  const n = fromSettings ?? asNumber(prop(body, 'n_ctx'))
  return typeof n === 'number' && n > 0 ? n : null
}

/** Fenster und Decke, wie eine Quelle sie nennt. null heisst "nicht gesagt". */
export interface ProbedContext {
  /** Das Fenster, mit dem der Server LAEUFT. */
  window: number | null
  /** Die trainierte Decke des Modells. Nie das laufende Fenster. */
  trained: number | null
}

const positive = (n: number | undefined): number | null =>
  typeof n === 'number' && n > 0 ? n : null

/**
 * Eine einzelne Modellkarte, egal ob aus der Liste `/v1/models` oder aus dem
 * Einzelabruf `/v1/models/<id>`: beide tragen dieselbe Karte.
 *
 * Fenster: vLLM schreibt `max_model_len` (die harte Grenze dieser
 * Bereitstellung), LU Cloud `context_length`, llama-server legt in seinen
 * `meta`-Block `n_ctx`, und das ist dieselbe Zahl, die `/props` nennt.
 *
 * Decke: `meta.n_ctx_train` beim llama-server, `n_ctx_train` obenauf bei den
 * Nachbauten. Bis zum 11.09.2026 lasen beide Leser dieser Karte die Decke als
 * Fenster; gemessen an einem Server mit `--ctx-size 16384` kam 40960 heraus.
 */
export function parseModelRowContext(row: unknown): ProbedContext {
  return {
    window: positive(
      asNumber(prop(row, 'max_model_len')) ??
        asNumber(prop(row, 'context_window')) ??
        asNumber(prop(row, 'context_length')) ??
        asNumber(prop(prop(row, 'meta'), 'n_ctx')) ??
        asNumber(prop(row, 'n_ctx')),
    ),
    trained: positive(
      asNumber(prop(prop(row, 'meta'), 'n_ctx_train')) ?? asNumber(prop(row, 'n_ctx_train')),
    ),
  }
}

/**
 * Der Eintrag fuer das gesuchte Modell aus einer `/v1/models`-Liste.
 *
 * Faellt auf den einzigen Eintrag zurueck, wenn die Id nicht passt: ein
 * llama-server, der mit einem Modell laeuft, nennt es oft anders als der
 * Nutzer es im Modellfeld stehen hat, und eine Liste mit genau einem Eintrag
 * laesst keine Verwechslung zu.
 */
export function parseModelsListContext(body: unknown, model: string): ProbedContext {
  const list = prop(body, 'data') ?? prop(body, 'models')
  const rows = Array.isArray(list) ? list.filter(isRecord) : []
  if (rows.length === 0) return { window: null, trained: null }
  const hit =
    rows.find((r) => prop(r, 'id') === model) ??
    rows.find((r) => prop(r, 'root') === model) ??
    (rows.length === 1 ? rows[0] : undefined)
  if (!hit) return { window: null, trained: null }
  return parseModelRowContext(hit)
}

/**
 * KoboldCpp `GET /api/extra/true_max_context_length`.
 *
 * Antwortet `{ "value": 4096 }`. Der Name sagt "true", weil KoboldCpp daneben
 * eine zweite, kleinere Zahl fuehrt (die des laufenden Generierungsprofils);
 * die wahre ist die, mit der der Server gestartet wurde.
 */
export function parseKoboldMaxContext(body: unknown): number | null {
  if (typeof body === 'number') return body > 0 ? body : null
  const n = asNumber(prop(body, 'value'))
  return typeof n === 'number' && n > 0 ? n : null
}

/**
 * LM Studio `GET /api/v0/models/<id>`.
 *
 * `max_context_length` ist das Koennen des Modells, `loaded_context_length`
 * das, was gerade allokiert ist. Beide getrennt, aus demselben Grund wie oben:
 * LM Studio schneidet jeden Prompt ueber dem geladenen Wert hart ab, also ist
 * das geladene das Fenster und das Koennen nur die Decke.
 */
export function parseLmStudioModel(body: unknown): { loaded: number | null; max: number | null } {
  return {
    loaded: positive(asNumber(prop(body, 'loaded_context_length'))),
    max: positive(
      asNumber(prop(body, 'max_context_length')) ?? asNumber(prop(body, 'context_length')),
    ),
  }
}

/** A positive count, also when the server wrote it as a string. */
const positiveCount = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * Ollama `POST /api/show`: the length the body names, or null.
 *
 *   1. `model_info`: `general.context_length`, then any architecture key that
 *      ends in `.context_length` (qwen2, gemma3, llama). Ollama always fills one.
 *   2. `parameters`: `num_ctx`, as an object or as a Modelfile line.
 *
 * null is "not said", and a server that emulates the Ollama API may say
 * nothing at all here: KoboldCpp answers with an empty `model_info` (GH #166).
 * What to ask next is the caller's business (api/ollama.ts).
 */
export function parseOllamaShowContext(info: unknown): number | null {
  const modelInfo = prop(info, 'model_info')
  if (isRecord(modelInfo)) {
    const general = positiveCount(modelInfo['general.context_length'])
    if (general) return general
    for (const [k, v] of Object.entries(modelInfo)) {
      if (k.endsWith('.context_length')) {
        const n = positiveCount(v)
        if (n) return n
      }
    }
  }
  // GH #201: a server that emulates Ollama (KoboldCpp, or a proxy in front
  // of it) can name the length outside `model_info`: as a plain
  // `context_length`, as `<arch>.context_length` beside it, or in `details`.
  // Ollama itself never does, so for Ollama nothing changes.
  for (const where of [info, prop(info, 'details')]) {
    if (!isRecord(where)) continue
    const plain = positiveCount(where.context_length)
    if (plain) return plain
    for (const [k, v] of Object.entries(where)) {
      if (k.endsWith('.context_length')) {
        const n = positiveCount(v)
        if (n) return n
      }
    }
  }
  const params = prop(info, 'parameters')
  if (isRecord(params)) {
    const n = positiveCount(params.num_ctx)
    if (n) return n
  } else if (typeof params === 'string') {
    const match = params.match(/num_ctx\s+(\d+)/)
    if (match) return positiveCount(match[1])
  }
  return null
}
