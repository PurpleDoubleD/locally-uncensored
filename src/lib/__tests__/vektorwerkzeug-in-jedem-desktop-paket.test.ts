/**
 * Das Vektorwerkzeug des Neuron tweakers (lu-llama-cvector-generator, 3.0.9
 * P11) kommt mit jedem Desktop-Paket: Mac, Windows, Linux.
 *
 * FEHLER-P11 #7 (I1, Davids Vorgabe vom 29.10.: "alles was man braucht muss
 * in app installierbar sein. mac linux windows."): Linux baute es nicht, das
 * Overlay fuehrte es nicht, ohne es gehen fertige und eigene Regler nicht.
 * Ein Overlay mit eigener externalBin-Liste ersetzt die des Basis-Configs,
 * also muss jedes es selbst nennen, und der Bau muss es fuer jedes Ziel
 * bauen. release.yml prueft je Plattform, dass es da ist.
 *
 * Gegenprobe: ohne die Zeile in tauri.linux.conf.json oder ohne
 * x86_64-unknown-linux-gnu in cvector_ships_for ist der Fall rot.
 *
 * Lauf: npx vitest run src/lib/__tests__/vektorwerkzeug-in-jedem-desktop-paket.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const conf = (name: string) => JSON.parse(read(`src-tauri/${name}`))
const TOOL = 'bin/lu-llama-cvector-generator'

describe('das Vektorwerkzeug steht in jedem Desktop-Paket', () => {
  for (const name of ['tauri.macos.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json']) {
    it(name, () => {
      const bins: string[] = conf(name).bundle.externalBin
      expect(bins).toContain('bin/lu-llama-server')
      expect(bins).toContain(TOOL)
    })
  }

  it('der Bau baut es fuer alle drei Ziele', () => {
    const fn = read('scripts/build-llama.sh').split('cvector_ships_for() {')[1].split('}')[0]
    for (const triple of ['*-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
      expect(fn).toContain(triple)
    }
  })

  it('der Release prueft es je Plattform und rechnet unter Linux echt', () => {
    const release = read('.github/workflows/release.yml')
    expect(release).toContain('test -f "src-tauri/bin/lu-llama-cvector-generator-${{ matrix.sidecar_triple }}.exe"')
    expect(release).toContain('test -x "src-tauri/bin/lu-llama-cvector-generator-${{ matrix.sidecar_triple }}"')
    expect(release).toContain('test -x "src-tauri/bin/lu-llama-cvector-generator-$SIDECAR_TRIPLE"')
    expect(release).toContain('Vector tool computes from a moved directory (P11)')
    expect(release.match(/for exe in lu-llama-server lu-llama-cvector-generator; do/g)).toHaveLength(2)
  })
})
