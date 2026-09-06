/**
 * SICHERHEITSBEFUND: die Zielpfade der Modell-Download-Endpunkte kamen
 * ungeprüft aus dem Request-Körper.
 *
 * Vier Endpunkte in `vite.config.ts` bauten mit `node:path.join` einen Pfad
 * aus Feldern des Körpers und schrieben oder lasen dann mit echten fs-Aufrufen
 * darauf. `join` normalisiert `..` klaglos weg — es ist keine Grenze:
 *
 *   POST /local-api/download-model
 *   { "url": "http://…", "subfolder": "../../../../../..", "filename": ".ssh/authorized_keys" }
 *   → schrieb die heruntergeladene Datei ausserhalb der ComfyUI-Installation.
 *
 *   POST /local-api/install-custom-node   { "nodeName": "../../../.." }
 *   → `git clone` in ein beliebiges Verzeichnis.
 *
 *   POST /local-api/check-model-sizes     { "files": [{ "subfolder": "../../..", … }] }
 *   → Existenz und Grösse beliebiger Dateien abtastbar.
 *
 * Diese Tests sind die Grenze. Die Wurzelregel ist dieselbe wie in
 * `src/lib/dev-fs-jail.ts`; nur die Wurzel ist die ComfyUI-Installation statt
 * des Agenten-Arbeitsordners.
 *
 * NEGATIVE CONTROL (von Hand geprüft):
 *   • in `comfyDestPath` das `containWithin(root, …)` durch
 *     `lexicalNormalize(`${root}/${subfolder}/${filename}`)` ersetzen
 *     → jeder Ausbruchsfall unten wird rot.
 *   • in `downloadToPathDest` dasselbe → "filename kann destDir nicht verlassen" rot.
 *   • in `customNodeDir` das `containWithin` weglassen → "nodeName ist ein Name,
 *     kein Pfad" wird rot.
 *   • in `repoBasename` das `.git`-Abschneiden entfernen → "der letzte
 *     Pfadteil der Repo-URL" wird rot.
 *
 * Run: npx vitest run src/dev/__tests__/model-paths.test.ts
 */
import { describe, expect, it } from 'vitest'
import { JailEscapeError } from '../../lib/dev-fs-jail'
import {
  comfyDestPath,
  customNodeDir,
  downloadToPathDest,
  modelDirCandidates,
  repoBasename,
} from '../model-paths'

const COMFY = '/Users/dev/ComfyUI'

describe('comfyDestPath — der gute Fall', () => {
  it('legt ein Modell unter models/ ab', () => {
    expect(comfyDestPath(COMFY, 'checkpoints', 'sd15.safetensors', 'separator'))
      .toBe(`${COMFY}/models/checkpoints/sd15.safetensors`)
  })

  it('erlaubt eine Unterebene im subfolder', () => {
    expect(comfyDestPath(COMFY, 'diffusion_models/wan', 'wan.gguf', 'separator'))
      .toBe(`${COMFY}/models/diffusion_models/wan/wan.gguf`)
  })

  it('kennt den custom_nodes-Zweig mit Trenner', () => {
    expect(comfyDestPath(COMFY, 'custom_nodes/ComfyUI-GGUF', 'x.py', 'separator'))
      .toBe(`${COMFY}/custom_nodes/ComfyUI-GGUF/x.py`)
  })

  it('die drei Endpunkte entscheiden custom_nodes verschieden — und das bleibt sichtbar', () => {
    // 'prefix' (check-model-sizes) zählt schon den blossen Präfix mit …
    expect(comfyDestPath(COMFY, 'custom_nodes_alt', 'x', 'prefix'))
      .toBe(`${COMFY}/custom_nodes_alt/x`)
    // … 'separator' (download-model) verlangt den Trenner …
    expect(comfyDestPath(COMFY, 'custom_nodes_alt', 'x', 'separator'))
      .toBe(`${COMFY}/models/custom_nodes_alt/x`)
    // … und 'never' (resume-download) kennt den Fall gar nicht.
    expect(comfyDestPath(COMFY, 'custom_nodes/x', 'y', 'never'))
      .toBe(`${COMFY}/models/custom_nodes/x/y`)
  })
})

describe('comfyDestPath — der Käfig', () => {
  const ausbrüche: [string, string][] = [
    ['../../../../../..', '.ssh/authorized_keys'],
    ['..', 'x'],
    ['checkpoints/../../..', 'x'],
    ['./../../etc', 'passwd'],
    ['..\\..\\..\\Windows', 'System32'],
  ]

  it.each(ausbrüche)('lehnt subfolder %j ab', (subfolder, filename) => {
    expect(() => comfyDestPath(COMFY, subfolder, filename, 'separator')).toThrow(JailEscapeError)
  })

  it('lehnt einen absoluten subfolder ab', () => {
    expect(() => comfyDestPath(COMFY, '/etc', 'passwd', 'separator')).toThrow(JailEscapeError)
    expect(() => comfyDestPath(COMFY, 'C:\\Windows', 'x', 'separator')).toThrow(JailEscapeError)
  })

  it('lehnt ein filename ab, das aus dem subfolder herausführt', () => {
    expect(() => comfyDestPath(COMFY, 'checkpoints', '../../../../../../etc/passwd', 'separator'))
      .toThrow(JailEscapeError)
  })

  it('ein absoluter filename bleibt im Käfig statt ihn zu ersetzen', () => {
    // node:path.join hätte hier `${COMFY}/models/checkpoints/etc/passwd`
    // gebaut — dasselbe Ergebnis, aber aus Versehen. Hier ist es die Regel.
    expect(comfyDestPath(COMFY, 'checkpoints', '/etc/passwd', 'separator'))
      .toBe(`${COMFY}/models/checkpoints/etc/passwd`)
  })

  it('ein Präfix ist kein Verzeichnis', () => {
    // `${COMFY}-evil` fängt mit `${COMFY}` an, liegt aber nicht darin.
    expect(() => comfyDestPath(COMFY, '../ComfyUI-evil', 'x', 'separator')).toThrow(JailEscapeError)
  })

  it('lässt einen Namen mit Punkten in Ruhe', () => {
    expect(comfyDestPath(COMFY, 'checkpoints', 'v1..5.safetensors', 'separator'))
      .toBe(`${COMFY}/models/checkpoints/v1..5.safetensors`)
    expect(comfyDestPath(COMFY, 'checkpoints', '.hidden', 'separator'))
      .toBe(`${COMFY}/models/checkpoints/.hidden`)
  })
})

describe('downloadToPathDest', () => {
  it('legt die Datei in das gewählte Verzeichnis', () => {
    expect(downloadToPathDest('/Users/dev/.lmstudio/models', 'q4.gguf'))
      .toBe('/Users/dev/.lmstudio/models/q4.gguf')
  })

  it('filename kann destDir nicht verlassen', () => {
    // destDir ist hier absichtlich frei (das ist der Zweck des Endpunkts);
    // filename hat damit nichts zu tun.
    expect(() => downloadToPathDest('/Users/dev/.lmstudio/models', '../../../.bashrc'))
      .toThrow(JailEscapeError)
    expect(() => downloadToPathDest('/Users/dev/.lmstudio/models', '/etc/cron.d/x'))
      .toThrow(JailEscapeError)
  })
})

describe('repoBasename', () => {
  it('nimmt den letzten Pfadteil der Repo-URL', () => {
    expect(repoBasename('https://github.com/city96/ComfyUI-GGUF.git')).toBe('ComfyUI-GGUF')
    expect(repoBasename('https://github.com/city96/ComfyUI-GGUF')).toBe('ComfyUI-GGUF')
    expect(repoBasename('https://github.com/city96/ComfyUI-GGUF/')).toBe('ComfyUI-GGUF')
    expect(repoBasename('git@github.com:city96/ComfyUI-GGUF.git')).toBe('ComfyUI-GGUF')
    // Auch der Rückwärts-Trenner zählt: der Dev-Server läuft auch auf Windows,
    // wo `node:path.basename` genauso trennt.
    expect(repoBasename('C:\\repos\\ComfyUI-GGUF.git')).toBe('ComfyUI-GGUF')
  })

  it('gibt für nichts nichts zurück', () => {
    expect(repoBasename('')).toBe('')
    expect(repoBasename('///')).toBe('')
  })
})

describe('customNodeDir', () => {
  it('benutzt den nodeName, wenn er da ist', () => {
    expect(customNodeDir(COMFY, 'ComfyUI-GGUF', 'https://github.com/city96/ComfyUI-GGUF.git'))
      .toBe(`${COMFY}/custom_nodes/ComfyUI-GGUF`)
  })

  it('fällt auf den letzten Teil der Repo-URL zurück', () => {
    expect(customNodeDir(COMFY, '', 'https://github.com/city96/ComfyUI-GGUF.git'))
      .toBe(`${COMFY}/custom_nodes/ComfyUI-GGUF`)
    expect(customNodeDir(COMFY, '   ', 'https://github.com/city96/ComfyUI-GGUF.git'))
      .toBe(`${COMFY}/custom_nodes/ComfyUI-GGUF`)
  })

  it('nodeName ist ein Name, kein Pfad', () => {
    for (const name of ['../../..', '../evil', '/etc/cron.d', '..\\..\\evil']) {
      expect(() => customNodeDir(COMFY, name, 'https://x/y.git'), name).toThrow(JailEscapeError)
    }
  })

  it('auch der Rückfall aus der Repo-URL geht durch den Käfig', () => {
    expect(() => customNodeDir(COMFY, '', 'https://evil/..')).toThrow()
  })

  it('ohne nodeName und ohne brauchbare URL wird nichts angelegt', () => {
    expect(() => customNodeDir(COMFY, '', '')).toThrow('Missing nodeName and unusable repoUrl')
  })
})

describe('modelDirCandidates', () => {
  it('gibt jedem Anbieter sein eigenes Verzeichnis', () => {
    // Vorher bekam JEDER Anbieter das von LM Studio zurück, auch Ollama.
    expect(modelDirCandidates('ollama')).toEqual([['.ollama', 'models']])
    expect(modelDirCandidates('jan')).toEqual([['.jan', 'models'], ['jan', 'models']])
    expect(modelDirCandidates('gpt4all')).toEqual([['.cache', 'gpt4all']])
    expect(modelDirCandidates('lm studio')[0]).toEqual(['.lmstudio', 'models'])
  })

  it('ist unabhängig von Gross-/Kleinschreibung und kennt beide LM-Studio-Schreibweisen', () => {
    expect(modelDirCandidates('Ollama')).toEqual(modelDirCandidates('ollama'))
    expect(modelDirCandidates('LMStudio')).toEqual(modelDirCandidates('lm studio'))
  })

  it('gibt für Unbekanntes nichts zurück, damit der Aufrufer sein Fallback nimmt', () => {
    expect(modelDirCandidates('')).toEqual([])
    expect(modelDirCandidates('irgendwas')).toEqual([])
  })
})
