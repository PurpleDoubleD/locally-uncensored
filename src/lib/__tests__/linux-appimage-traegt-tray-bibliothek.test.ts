/**
 * Die AppImage muss libayatana-appindicator3 mitbringen (GH #204).
 *
 * 3.0.8 startete auf CachyOS nicht: "Failed to load ayatana-appindicator3 or
 * appindicator3 dynamic library". 3.0.7 brachte die Bibliothek mit, 3.0.8
 * nicht. Ursache: @tauri-apps/cli packt sie nur ein, wenn es `tray-icon` am
 * ERSTEN `tauri`-Eintrag der Cargo.toml findet (find_dependency in
 * crates/tauri-cli/src/interface/rust/manifest.rs kehrt beim ersten Treffer
 * zurueck). Seit 3.0.8 steht dort `[dependencies] tauri` nur mit image-png,
 * `tray-icon` im Desktop-Target-Block, also sah die CLI kein Tray.
 *
 * Darum nennt tauri.linux.conf.json die Datei selbst, mit genau dem Schluessel,
 * den die CLI auch nimmt (dann fuegt eine reparierte CLI sie nicht doppelt
 * ein), und release.yml prueft die fertige AppImage.
 *
 * Gegenprobe: ohne den appimage.files-Eintrag ist der erste Fall rot.
 *
 * Lauf: npx vitest run src/lib/__tests__/linux-appimage-traegt-tray-bibliothek.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')
const conf = (name: string) => JSON.parse(read(`src-tauri/${name}`))

describe('Linux-Pakete bringen die Tray-Bibliothek mit oder verlangen sie', () => {
  it('die AppImage nimmt libayatana-appindicator3.so.1 vom Bau-Rechner mit', () => {
    const files = conf('tauri.linux.conf.json').bundle?.linux?.appimage?.files ?? {}
    expect(files['/usr/lib/libayatana-appindicator3.so.1']).toBe(
      '/usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1',
    )
  })

  it('das Overlay ueberschreibt die AppImage-Einstellung der Basis nicht', () => {
    // Tauri merged die Overlays als JSON Merge Patch: bundleMediaFramework
    // aus tauri.conf.json bleibt, solange das Overlay es nicht nennt.
    expect(conf('tauri.linux.conf.json').bundle.linux.appimage.bundleMediaFramework).toBeUndefined()
    expect(conf('tauri.conf.json').bundle.linux.appimage.bundleMediaFramework).toBe(true)
  })

  it('.deb und .rpm verlangen die Bibliothek als Abhaengigkeit', () => {
    const linux = conf('tauri.conf.json').bundle.linux
    expect(linux.deb.depends).toContain('libayatana-appindicator3-1')
    expect(linux.rpm.depends).toContain('libappindicator-gtk3')
  })

  it('der Release-Bau prueft die fertige AppImage auf die Bibliothek und ihre Abhaengigkeiten', () => {
    const yml = read('.github/workflows/release.yml')
    for (const lib of [
      'libayatana-appindicator3.so.1',
      'libayatana-indicator3.so.7',
      'libayatana-ido3-0.4.so.0',
      'libdbusmenu-glib.so.4',
      'libdbusmenu-gtk3.so.4',
    ]) {
      expect(yml, lib).toContain(lib)
    }
    expect(yml).toContain('(GH #204)')
  })

  it('die Bau-Maschine hat das Paket installiert, aus dem die Datei kommt', () => {
    expect(read('.github/workflows/release.yml')).toContain('libayatana-appindicator3-dev')
  })
})
