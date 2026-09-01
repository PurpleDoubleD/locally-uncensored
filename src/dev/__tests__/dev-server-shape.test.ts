/**
 * Zusicherungen ÜBER `vite.config.ts` selbst — die Klammer zwischen den
 * herausgelösten Modulen und der Datei, die sie benutzen soll.
 *
 * Warum statisch: die Middlewares hängen an einem echten `ViteDevServer` mit
 * laufendem ComfyUI-Starter, Ollama-Spawn und Whisper-Prozess; sie im Test zu
 * instanziieren hiesse, den halben Rechner zu starten. Was hier geprüft wird,
 * ist deshalb nicht das Verhalten, sondern dass die FORM der Fehler, die in
 * `src/dev/` behoben sind, nicht in `vite.config.ts` zurückkommt. Das Verhalten
 * selbst steht in http-body.test.ts, ssrf-policy.test.ts und
 * model-paths.test.ts — diese Datei sagt nur: die Datei benutzt sie auch.
 *
 * Dieselbe Technik benutzt schon `src/lib/__tests__/app-identity.test.ts` auf
 * derselben Datei.
 *
 * NEGATIVE CONTROL (von Hand geprüft): einen der verbotenen Ausdrücke in
 * vite.config.ts wieder einsetzen (z. B. `const x = JSON.parse(body)`) → der
 * zugehörige Fall wird rot.
 *
 * Run: npx vitest run src/dev/__tests__/dev-server-shape.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * `vite.config.ts` ohne reine Kommentarzeilen.
 *
 * Die Kommentare der Datei ZITIEREN die alten Fehlerformen, um zu erklären,
 * warum es die Module in `src/dev/` gibt — ein Grep über den Rohtext würde also
 * genau die Erklärung als Verstoss lesen. Nur ganze Kommentarzeilen fallen weg;
 * ein Verstoss im Code steht nie auf einer solchen Zeile.
 */
const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
  .split('\n')
  .filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  .join('\n')

/**
 * Der Textausschnitt EINES Handlers.
 *
 * Ein Grep über die ganze Datei beantwortet „steht der Wächter irgendwo" —
 * die Frage ist aber „steht er in DIESEM Handler". `bis` ist die nächste
 * Marke; ohne Angabe endet der Ausschnitt an der nächsten Middleware.
 */
function ausschnitt(von: string, bis?: string | null): string {
  const start = viteConfig.indexOf(von)
  expect(start, `nicht gefunden: ${von}`).toBeGreaterThanOrEqual(0)
  const rest = viteConfig.slice(start + von.length)
  const marke = bis ?? "server.middlewares.use('/local-api/"
  const ende = rest.indexOf(marke)
  return ende < 0 ? rest : rest.slice(0, ende)
}

describe('der Request-Körper', () => {
  it('wird nirgends mehr chunkweise zu einem String addiert', () => {
    // `body += chunk` dekodiert jeden Chunk einzeln; ein Zeichen auf der
    // Chunk-Grenze zerfällt. Siehe http-body.test.ts.
    expect(viteConfig).not.toMatch(/body \+= c\b/)
    expect(viteConfig.match(/=> \{ body \+= /g)).toBeNull()
  })

  it('wird nirgends mehr ungeschützt geparst', () => {
    // `JSON.parse(body)` in einem `end`-Handler: der Wurf kommt an, wenn die
    // Middleware längst zurückgekehrt ist, niemand fängt ihn, und der ganze
    // `npm run dev`-Prozess endet. Drei Endpunkte hatten genau das.
    expect(viteConfig).not.toContain('JSON.parse(body)')
  })

  it('geht durch den einen geprüften Leser', () => {
    // Zwanzig Handler, ein Einstieg. Sinkt diese Zahl deutlich, wurde wieder
    // von Hand gepuffert.
    const stellen = viteConfig.match(/withJsonBody\(req, res, \(body\) =>/g) ?? []
    expect(stellen.length).toBeGreaterThanOrEqual(20)
  })
})

describe('Pfade aus dem Request', () => {
  it('bauen den ComfyUI-Zielpfad nicht mehr von Hand zusammen', () => {
    // `join(comfyPath, 'models', subfolder)` mit `subfolder: '../../..'` schrieb
    // ausserhalb der Installation. Siehe model-paths.test.ts.
    expect(viteConfig).not.toContain("join(comfyPath, 'models', subfolder")
    expect(viteConfig).not.toContain("join(comfyPath, 'models', subfolder, id)")
    expect(viteConfig).not.toContain('join(destDir, filename)')
    expect(viteConfig).not.toContain('join(customNodesDir, node_name')
  })

  it('gehen durch den Käfig', () => {
    expect(viteConfig).toContain('comfyDestPath(')
    expect(viteConfig).toContain('downloadToPathDest(')
    expect(viteConfig).toContain('customNodeDir(')
  })
})

describe('Prozessaufrufe aus dem Request', () => {
  it('bauen keine Shell-Zeile mehr aus fremden Werten', () => {
    // `execSync(\`git clone "${repo_url}" "${targetDir}"\`)`: die
    // doppelten Anführungszeichen sind keine Grenze, `x"; …; echo "` war ein
    // zweites Kommando.
    expect(viteConfig).not.toContain('git clone "${')
    expect(viteConfig).not.toContain('pip install -r "${')
    expect(viteConfig).toContain("execFileSync('git', ['clone'")
  })
})

describe('der SSRF-Wächter', () => {
  it('entscheidet nicht mehr auf der Schreibweise der Adresse', () => {
    // Die alten Präfix-/Regex-Prüfungen sahen `0:0:0:0:0:ffff:127.0.0.1` nicht.
    // Siehe ssrf-policy.test.ts.
    expect(viteConfig).not.toContain("lc.startsWith('fe80')")
    expect(viteConfig).not.toContain("lc.startsWith('64:ff9b:')")
    expect(viteConfig).toContain('createSsrfPolicy(')
  })

  it('lässt net.isIP das Orakel bleiben, statt es nachzubauen', () => {
    expect(viteConfig).toContain('net.isIP(value)')
  })

  it('hängt auch am Model-Download, nicht nur an den beiden Proxies', () => {
    // DER BEFUND: `downloadFile` holte jede URL, die der Aufrufer angab, und
    // schrieb die Antwort auf die Platte — `http://169.254.169.254/…`
    // eingeschlossen, zwei Bildschirmseiten unter `proxy-image` /
    // `proxy-download`, die genau dagegen geschützt sind. Der gepackte Build
    // hat an derselben Stelle `proxy::validate_public_url(url)?`
    // (download.rs::download_with_progress).
    const downloadFile = ausschnitt('function downloadFile(', 'server.middlewares.use(\'/local-api/download-model\'')
    expect(downloadFile).toContain('await assertPublicUrl(requestUrl)')
  })

  it('prüft JEDEN Weiterleitungs-Hop, nicht nur den ersten', () => {
    // Der klassische Bypass: eine öffentliche URL antwortet mit 302 auf
    // 169.254.169.254. Rust benutzt dafür `ssrf_safe_redirect_policy`; hier
    // muss die Weiterleitung zurück durch `doRequest` — und damit durch den
    // Wächter — statt an ihm vorbei.
    const downloadFile = ausschnitt('function downloadFile(', 'server.middlewares.use(\'/local-api/download-model\'')
    // Der Wächter steht VOR dem ersten `proto.get`, nicht dahinter.
    const wächter = downloadFile.indexOf('await assertPublicUrl(requestUrl)')
    expect(wächter).toBeGreaterThanOrEqual(0)
    expect(wächter).toBeLessThan(downloadFile.indexOf('proto.get('))
    // Und die Weiterleitung geht durch dieselbe Funktion.
    expect(downloadFile).toMatch(/doRequest\(next, redirectCount \+ 1\)/)
    expect(downloadFile).not.toMatch(/doRequest\(response\.headers\.location/)
  })
})

describe('die fünf fs-Endpunkte', () => {
  // DER BEFUND: `fs-read`, `fs-write`, `fs-list`, `fs-search` und `fs-info`
  // prüften den Pfad nicht. `{"path":"../../.ssh/id_rsa"}` verliess den
  // Arbeitsordner, und `fs-write` schrieb auf jeden absoluten Pfad. Die Regel
  // selbst steht in src/lib/dev-fs-jail.ts (Port von `resolve_path` in
  // src-tauri/src/commands/filesystem.rs), der Weg dorthin in
  // src/dev/fs-request-path.ts — siehe fs-request-path.test.ts.

  it('bauen den Pfad nicht mehr selbst zusammen', () => {
    // Der Ausdruck, der in allen fünf Handlern stand.
    expect(viteConfig).not.toMatch(/isAbsolute\([A-Za-z]+\)\s*\?/)
    expect(viteConfig).not.toContain("join(os.homedir(), AGENT_WORKSPACE_DIR, filePath)")
    expect(viteConfig).not.toContain("join(os.homedir(), AGENT_WORKSPACE_DIR, dirPath)")
  })

  it('gehen alle fünf durch den Käfig', () => {
    const stellen = viteConfig.match(/resolveFsRequestPath\(body, os\.homedir\(\)\)/g) ?? []
    expect(stellen.length).toBe(5)
    for (const endpunkt of ['fs-read', 'fs-write', 'fs-list', 'fs-search', 'fs-info']) {
      const bis = endpunkt === 'fs-info' ? "server.middlewares.use('/local-api/system-info'" : null
      const handler = ausschnitt(`server.middlewares.use('/local-api/${endpunkt}'`, bis)
      expect(handler, endpunkt).toContain('resolveFsRequestPath(body, os.homedir())')
    }
  })

  it('lösen den Pfad VOR dem try auf, damit ein Ausbruch kein 200 wird', () => {
    // fs-list und fs-search antworten in ihrem catch mit 200 und leerer
    // Liste; läge der Käfig darin, sähe ein Ausbruchsversuch aus wie ein
    // leeres Verzeichnis statt wie ein 403.
    for (const endpunkt of ['fs-read', 'fs-write', 'fs-list', 'fs-search', 'fs-info']) {
      const bis = endpunkt === 'fs-info' ? "server.middlewares.use('/local-api/system-info'" : null
      const handler = ausschnitt(`server.middlewares.use('/local-api/${endpunkt}'`, bis)
      expect(handler.indexOf('resolveFsRequestPath('), endpunkt).toBeLessThan(handler.indexOf('try {'))
    }
  })

  it('lassen JailEscapeError als 403 heraus', () => {
    // `withJsonBody` fängt, was der Handler wirft, und `failRequest` ist der
    // Weg für die Handler, die selbst fangen.
    expect(viteConfig).toContain("err instanceof JailEscapeError ? 403 : 400")
  })
})
