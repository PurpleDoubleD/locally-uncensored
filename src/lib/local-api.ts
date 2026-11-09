/**
 * Die lokale Modell-API — der Teil, der sich ohne Fenster pruefen laesst.
 *
 * Der Server steht in Rust (src-tauri/src/commands/local_api.rs). Hier steht,
 * was die Oberflaeche darueber sagt und rechnet: die Adresse, die der Nutzer
 * kopiert, der Beispielaufruf, den er einfuegt, und die Pruefung des Ports.
 *
 * Warum getrennt: die Tests dieses Hauses laufen in `environment: 'node'` und
 * rendern kein einziges `.tsx`. Was in der Komponente steht, ist damit
 * unbewiesen — und die Zeichenkette, die jemand in seine Anwendung einfuegt,
 * ist genau die Stelle, an der ein Tippfehler eine Stunde kostet.
 */

/** Der Vorgabeport. Muss zu DEFAULT_LOCAL_API_PORT in local_api.rs passen. */
export const LOCAL_API_DEFAULT_PORT = 8129

/**
 * Ports, die auf diesem Rechner schon jemandem gehoeren.
 *
 * Nicht als Verbot gedacht, sondern als Warnung mit Namen: wer die API auf
 * 11434 stellt, nimmt Ollama den Platz weg und sucht danach den Fehler an der
 * falschen Stelle. Der Text nennt deshalb immer, WER dort sitzt.
 */
export const BELEGTE_PORTS: Record<number, string> = {
  1234: 'LM Studio',
  5173: 'a Vite dev server',
  5273: 'the Vite dev server LU runs in development',
  8127: 'the LU Engine (llama-server)',
  8188: 'ComfyUI',
  11434: 'Ollama',
  11435: 'the Remote Access server for your phone',
}

export type PortUrteil =
  | { ok: true }
  | { ok: false; grund: string }

/**
 * Ist dieser Port brauchbar?
 *
 * Unter 1024 braucht es auf macOS und Linux Rootrechte — ein Server, der beim
 * Start scheitert, ist schlechter als einer, der gar nicht erst angeboten wird.
 */
export function pruefePort(port: number): PortUrteil {
  if (!Number.isInteger(port)) return { ok: false, grund: 'The port has to be a whole number.' }
  if (port < 1024) return { ok: false, grund: 'Ports below 1024 need administrator rights.' }
  if (port > 65535) return { ok: false, grund: 'The highest possible port is 65535.' }
  const wem = BELEGTE_PORTS[port]
  if (wem) return { ok: false, grund: `Port ${port} belongs to ${wem}.` }
  return { ok: true }
}

/**
 * Die Basis-URL, die der Nutzer in seinen Client kopiert.
 *
 * Bei `lan` steht hier NICHT 0.0.0.0. Das ist die Bindeadresse des Servers und
 * keine Adresse, unter der ein anderes Geraet ihn erreicht — wer 0.0.0.0 in
 * einen Client einträgt, bekommt eine Fehlermeldung und keinen Hinweis darauf,
 * warum. Steht die LAN-Adresse des Rechners zur Verfuegung, nehmen wir die;
 * sonst einen Platzhalter, der sich selbst erklaert.
 */
export function localApiBaseUrl(port: number, lan: boolean, lanHost?: string): string {
  if (!lan) return `http://127.0.0.1:${port}/v1`
  return `http://${lanHost && lanHost.trim() ? lanHost.trim() : '<this-machine-IP>'}:${port}/v1`
}

/**
 * Ein Aufruf, der wirklich laeuft — zum Kopieren.
 *
 * Das Token steht ausgeschrieben drin und nicht als `$LU_TOKEN`: wer den
 * Befehl kopiert, will ihn einfuegen und ausfuehren. Eine Variable, die er
 * erst setzen muss, ist ein zweiter Schritt, den die Zwischenablage nicht
 * mitnimmt. Die Oberflaeche verdeckt das Token, bis er es sehen will.
 */
export function curlBeispiel(base: string, token: string, modell: string): string {
  return [
    `curl ${base}/chat/completions \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"${modell}","messages":[{"role":"user","content":"hallo"}]}'`,
  ].join('\n')
}

/**
 * Die Einstellungen einer OpenAI-kompatiblen Anwendung, als Paar.
 *
 * Fast jeder Client fragt genau diese zwei Dinge ab, und fast jeder nennt sie
 * anders. Zusammen ausgegeben nimmt es dem Nutzer das Raten ab, welches Feld
 * welches ist.
 */
export function clientFelder(base: string, token: string): Array<{ feld: string; wert: string }> {
  return [
    { feld: 'Base URL', wert: base },
    { feld: 'API Key', wert: token },
  ]
}

/**
 * Die kurze Anleitung "Use with SillyTavern / other apps" in der Einstellung.
 *
 * GitHub Discussion #14 (micnorian14): "API key not working even though I
 * haven't set one". Niemand setzt hier einen Schluessel selbst: LU erzeugt
 * ihn, und jede Anfrage braucht ihn. Discord: SillyTavern zeigte "no model
 * loaded", weil die Liste leer war (C57). Die Schritte nennen deshalb die
 * Felder so, wie SillyTavern sie nennt, und sagen, dass LU-Engine-Modelle beim
 * ersten Aufruf geladen werden.
 */
export interface AnleitungsAbschnitt {
  titel: string
  schritte: string[]
}

export function clientAnleitung(base: string): AnleitungsAbschnitt[] {
  return [
    {
      titel: 'SillyTavern',
      schritte: [
        'API Connections: API "Chat Completion", source "Custom (OpenAI-compatible)".',
        `Custom Endpoint (Base URL): ${base}`,
        'Custom API Key: the API Key above (copy button).',
        'Press Connect, then pick a model. lu/… are LU Engine models, ollama/… and lmstudio/… the other apps.',
      ],
    },
    {
      titel: 'Any other OpenAI-compatible app',
      schritte: [
        'Set the Base URL and the API Key from above. The key is required, also on this machine.',
        'Model: an id from GET /v1/models, for example lu/<model name>.',
        'An LU Engine model that is not loaded is loaded by the first request, so the first answer takes longer.',
      ],
    },
  ]
}

/**
 * Was die Oberflaeche ueber die Reichweite sagt.
 *
 * Der LAN-Satz ist bewusst konkret statt beruhigend: "andere Geraete" ist
 * hoeflich und falsch — es ist jedes Geraet im selben Netz, und in einem WLAN
 * mit Gaesten sind das fremde.
 */
export function reichweiteText(lan: boolean): string {
  return lan
    ? 'Any device on your network can reach the API, guests on the same Wi-Fi included. The token is then the only boundary.'
    : 'Only programs on this machine reach the API. Other devices on the network do not.'
}

/** Ob der aktuelle Stand ueberhaupt startbar ist. */
export function kannStarten(token: string, port: number): PortUrteil {
  if (!token.trim()) return { ok: false, grund: 'The API will not start without an API key. Press Generate below first.' }
  return pruefePort(port)
}

/**
 * Soll die API beim Start von LU von selbst hochkommen?
 *
 * fanezeu (23.10.2026) betreibt LU auf einem Linux-Server ohne Bildschirm
 * davor. Dort startet LU mit der Sitzung, und eine API, die erst nach einem
 * Klick in den Einstellungen laeuft, ist nach jedem Neustart weg. Gestartet
 * wird nur, was der Nutzer selbst eingeschaltet hat und was auch der Knopf
 * starten wuerde: ohne Token oder mit unbrauchbarem Port bleibt sie aus.
 */
export function sollBeimStartStarten(s: { mitLuStarten: boolean; token: string; port: number; laeuft: boolean }): boolean {
  return s.mitLuStarten && !s.laeuft && kannStarten(s.token, s.port).ok
}

/**
 * Die CORS-Erlaubnisliste aus dem, was der Nutzer ins Feld tippt.
 *
 * Warum das hier steht und nicht in der Komponente: es ist eine
 * Sicherheitsentscheidung, und die Tests dieses Hauses rendern kein `.tsx`.
 *
 * Der Kunden-Testbericht vom 02.09.2026 nennt das fehlende CORS als Fund 3 —
 * ohne Freigabe kann keine Weboberflaeche die lokale API benutzen. Die Antwort
 * darauf ist eine Liste, kein Schalter: der Nutzer BENENNT, wer seinen
 * Modellverkehr im Browser lesen darf.
 *
 * Was hier wegfaellt und warum:
 * - `*` — der Platzhalter macht die Liste bedeutungslos. Rust weist ihn
 *   ohnehin ab (`cors_erlaubt`); hier faellt er schon beim Tippen weg, damit
 *   niemand einen Eintrag sieht, der nichts tut.
 * - alles mit Pfad, Abfrage oder Fragment — eine Herkunft ist Schema, Host und
 *   Port, sonst nichts. `http://localhost:3000/app` als Herkunft trifft nie zu,
 *   und ein Eintrag, der nie trifft, ist eine Falle.
 * - Doppelte, in Eingabereihenfolge entdoppelt.
 */
export function parseCorsOrigins(text: string): string[] {
  const roh = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  const raus: string[] = []
  for (const eintrag of roh) {
    if (eintrag === '*') continue
    let u: URL
    try {
      u = new URL(eintrag)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    if (!u.hostname) continue
    if (u.pathname !== '/' && u.pathname !== '') continue
    if (u.search || u.hash || u.username || u.password) continue
    const norm = u.origin.toLowerCase()
    if (!raus.includes(norm)) raus.push(norm)
  }
  return raus
}

/**
 * Was unter dem Feld steht, wenn die Liste leer ist bzw. Eintraege hat.
 * Ein Satz, der den Zustand benennt, statt ihn den Nutzer raten zu lassen.
 */
export function corsText(origins: string[]): string {
  if (origins.length === 0) {
    return 'Closed. No web page may read this API. Command-line tools and apps are unaffected.'
  }
  return origins.length === 1
    ? `Open to ${origins[0]} only.`
    : `Open to ${origins.length} origins: ${origins.join(', ')}.`
}

// ── Was ueber die API gelaufen ist (GH Discussion #4 2026-09-22) ──

/** Die Zahlen, die `local_api_usage` seit dem letzten Start liefert. */
export interface LocalApiNutzung {
  since: number
  requests: number
  failed: number
  active: number
  promptTokens: number
  completionTokens: number
  withoutCounts: number
  lastModel: string | null
  lastAt: number | null
}

const zahl = (n: number) => n.toLocaleString('en-US')

function vorWieLangem(ms: number, jetzt: number): string {
  const s = Math.max(0, Math.round((jetzt - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/** Die Zeilen fuer das Panel. Sichtbarer Text ist Englisch. */
export function nutzungZeilen(u: LocalApiNutzung, jetzt: number): Array<{ feld: string; wert: string }> {
  return [
    // Gezaehlt wird, was ein Modell erreicht (chat, completions, embeddings),
    // nicht das Abfragen der Modellliste, das viele Werkzeuge im Sekundentakt
    // tun. Die 3.0.4-Gegenprobe (02.10.2026) rief /v1/models auf und las
    // "Requests 0" als Fehler; der Name sagt jetzt, was gezaehlt wird.
    { feld: 'Model requests', wert: u.failed > 0 ? `${zahl(u.requests)} (${zahl(u.failed)} failed)` : zahl(u.requests) },
    { feld: 'Running now', wert: zahl(u.active) },
    { feld: 'Tokens in', wert: zahl(u.promptTokens) },
    { feld: 'Tokens out', wert: zahl(u.completionTokens) },
    { feld: 'Last model', wert: u.lastModel ? `${u.lastModel}, ${vorWieLangem(u.lastAt ?? jetzt, jetzt)}` : 'none yet' },
  ]
}

/** Tokens kennt nur der Modellserver. Wo er keine meldet, steht das da,
 *  statt dass eine Schaetzung als Zaehlung auftritt. */
export function ohneZahlenText(u: LocalApiNutzung): string | null {
  if (u.withoutCounts === 0) return null
  const wer = u.withoutCounts === 1 ? '1 answer' : `${zahl(u.withoutCounts)} answers`
  return `${wer} came without token counts from the model server, so the totals above leave them out.`
}
