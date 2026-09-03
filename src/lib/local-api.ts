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
  5173: 'der Vite-Entwicklungsserver',
  5273: 'der Vite-Server dieses Experiment-Builds',
  8127: 'die LU Engine (llama-server)',
  8188: 'ComfyUI',
  11434: 'Ollama',
  11435: 'der Remote-Access-Server fuers Handy',
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
  if (!Number.isInteger(port)) return { ok: false, grund: 'Der Port muss eine ganze Zahl sein.' }
  if (port < 1024) return { ok: false, grund: 'Ports unter 1024 brauchen Administratorrechte.' }
  if (port > 65535) return { ok: false, grund: 'Der groesste moegliche Port ist 65535.' }
  const wem = BELEGTE_PORTS[port]
  if (wem) return { ok: false, grund: `Port ${port} gehoert ${wem}.` }
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
  return `http://${lanHost && lanHost.trim() ? lanHost.trim() : '<IP-dieses-Rechners>'}:${port}/v1`
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
 * Was die Oberflaeche ueber die Reichweite sagt.
 *
 * Der LAN-Satz ist bewusst konkret statt beruhigend: "andere Geraete" ist
 * hoeflich und falsch — es ist jedes Geraet im selben Netz, und in einem WLAN
 * mit Gaesten sind das fremde.
 */
export function reichweiteText(lan: boolean): string {
  return lan
    ? 'Jedes Geraet in deinem Netz kann die API erreichen — auch Gaeste im selben WLAN. Das Token ist dann die einzige Grenze.'
    : 'Nur Programme auf diesem Rechner erreichen die API. Andere Geraete im Netz nicht.'
}

/** Ob der aktuelle Stand ueberhaupt startbar ist. */
export function kannStarten(token: string, port: number): PortUrteil {
  if (!token.trim()) return { ok: false, grund: 'Ohne Token startet die API nicht. Erzeuge zuerst eines.' }
  return pruefePort(port)
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
    return 'Closed. No web page may read this API — command-line tools and apps are unaffected.'
  }
  return origins.length === 1
    ? `Open to ${origins[0]} only.`
    : `Open to ${origins.length} origins: ${origins.join(', ')}.`
}
