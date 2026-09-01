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
})
