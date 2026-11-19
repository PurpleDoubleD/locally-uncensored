#!/usr/bin/env node
// Prueft ein fertiges Android-Paket darauf, ob es veroeffentlicht werden darf.
//
// Aufruf:  node scripts/mobile/release/pruefe-android-paket.mjs <preset> <version> <code> <apk> [<aab>]
//          <preset>   play oder open
//          <version>  die Version, die das Paket tragen soll (3.0.7)
//          <code>     der versionCode dazu (30007001)
// Umgebung: LU_RELEASE_PROBE=1: das Paket stammt aus einem Probelauf (--probe). Ohne die
//          Variable ist ein Paket mit `probe` im Baubeleg ein Fund.
//          LU_ANDROID_CERT_SHA256 (freiwillig): der SHA-256-Fingerabdruck des
//          echten Zertifikats. Ist er gesetzt, muss das Paket genau ihn tragen.
//          LU_RELEASE_DIST (freiwillig): der Ordner der gebauten Seite, Standard dist.
// Ende 0:  alles bestanden. Ende 1: mindestens ein Punkt nicht. Ende 2: falscher Aufruf.
//
// Die Grundpruefung (Signatur gueltig, Paketangaben, Icon, nicht debuggable,
// Baubeleg) macht mobile-tests/checks/release.mjs, hier kommt nur dazu, was
// eine Veroeffentlichung zusaetzlich verlangt: keine Wegwerf-Signatur, das
// genannte Preset, kein Feature abnahme, kein Testhaken, nur arm64-v8a, die
// erwartete Baunummer, und am AAB: dasselbe Zertifikat, eine gueltige Signatur,
// Kennung, Version und Baunummer im Bundle selbst.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HIER = dirname(fileURLToPath(import.meta.url))
const WURZEL = resolve(HIER, '../../..')

const [preset, version, code, apk, aab] = process.argv.slice(2)
if (!['play', 'open'].includes(preset) || !version || !/^\d+$/.test(code ?? '') || !apk) {
  console.error('usage: pruefe-android-paket.mjs <play|open> <version> <code> <apk> [<aab>]')
  process.exit(2)
}

/** Der Probelauf der Release-Skripte (--probe). Die Pruefungen sind dieselben, nur das Urteil am Ende heisst Probe. */
const PROBE = process.env.LU_RELEASE_PROBE === '1'

let fehler = 0
const ok = (text) => console.log(`[package] ok    ${text}`)
const fail = (text) => {
  fehler += 1
  console.log(`[package] FAIL  ${text}`)
}
const pruefe = (bedingung, gut, schlecht) => (bedingung ? ok(gut) : fail(schlecht))
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
  return { ok: r.status === 0, aus: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Die Werkzeuge des JDK schreiben in der Sprache des Systems. Gelesen wird ihre Ausgabe englisch. */
const ENGLISCH = ['-J-Duser.language=en', '-J-Duser.country=US']

/** aapt2 aus den neuesten build-tools des SDK, wie in mobile-tests/checks/release.mjs. */
function aapt2Pfad() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk')
  const dir = join(sdk, 'build-tools')
  if (!existsSync(dir)) return null
  const versionen = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse()
  for (const v of versionen) if (existsSync(join(dir, v, 'aapt2'))) return join(dir, v, 'aapt2')
  return null
}

/** Platzhalter, mit denen nie veroeffentlicht wird: der Wegwerf-Schluessel dieses Repos und der Debug-Schluessel des SDK. */
const PLATZHALTER_DN = /WEGWERF|NICHT VEROEFFENTLICHEN|CN=Android Debug|O=Platzhalter/i

const { pruefeApk } = await import(join(WURZEL, 'mobile-tests/checks/release.mjs'))
const { stand } = await import(join(HIER, 'handy-version.mjs'))
const { bericht16kb } = await import(join(HIER, 'pruefe-16kb.mjs'))

// 1. Die Grundpruefung der Abnahme, mit der erwarteten Version.
const e = pruefeApk(apk, { version })
for (const p of e.pruefungen) pruefe(p.ok, `${p.name}${p.detail ? ` (${p.detail})` : ''}`, `${p.name}${p.detail ? `: ${p.detail}` : ''}`)
if (!e.pruefungen[0]?.ok) {
  console.log('[package] no package, nothing else to check')
  process.exit(1)
}

// 2. Die Signatur ist die echte.
const dn = e.signatur?.dn ?? ''
pruefe(!!dn && !PLATZHALTER_DN.test(dn), 'signed with a real certificate, not a placeholder', dn ? `throwaway signature: the package is signed with "${dn}". Point LU_ANDROID_KEY_PROPERTIES at the real key.properties and build again` : 'the package carries no signature')
const pin = (process.env.LU_ANDROID_CERT_SHA256 ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
if (pin) pruefe((e.signatur?.sha256 ?? '').toLowerCase() === pin, 'certificate matches LU_ANDROID_CERT_SHA256', 'the certificate of the package is not the one named in LU_ANDROID_CERT_SHA256')
else console.log('[package] note  LU_ANDROID_CERT_SHA256 is not set: the certificate is not compared with a known fingerprint')

// 3. Kennung, Version, Baunummer.
const soll = stand(WURZEL).android
pruefe(e.paket?.name === soll.kennung, `package name ${e.paket?.name}`, `package name is ${e.paket?.name}, the configuration says ${soll.kennung}`)
pruefe(e.paket?.versionName === version, `versionName ${version}`, `wrong version: the package carries versionName ${e.paket?.versionName}, expected ${version}`)
pruefe(e.paket?.versionCode === String(code), `versionCode ${code}`, `wrong version: the package carries versionCode ${e.paket?.versionCode}, expected ${code}`)

// 4. Womit es gebaut wurde (Baubeleg neben dem Paket, an das Paket gebunden).
pruefe(e.bau?.art === 'release', 'release build', `the build receipt says "${e.bau?.art ?? 'nothing'}", not release`)
pruefe(e.bau?.preset === preset, `preset ${preset}`, `the package was built with preset "${e.bau?.preset ?? 'none'}", expected ${preset}`)
pruefe((e.bau?.features ?? ['?']).length === 0, 'no cargo feature', `the package was built with cargo features "${(e.bau?.features ?? []).join(' ')}". Feature abnahme must never be in a package that is published`)
if (preset === 'play') pruefe(e.bau?.meldedienst === true, PROBE ? 'an https address stood in for the report service (probe placeholder)' : 'report service address was set', 'VITE_LU_REPORT_URL was not set when this package was built')
// Ein Probe-Paket (--probe: Platzhalter statt der Meldeadresse) besteht nur als Probe.
if (PROBE) pruefe(e.bau?.probe === true, 'the build receipt says probe', 'this is a probe run, but the build receipt of the package does not say probe: the package is not from this run')
else pruefe(e.bau?.probe !== true, 'not a probe package', 'this package comes from a probe run (--probe) and must never be published: a probe of a store preset carries a placeholder instead of the report service address')

// 5. Nur arm64-v8a, und kein Zeichen des Abnahmebaus in der Bibliothek oder in der Seite.
const liste = sh('unzip', ['-Z1', apk]).aus.split('\n')
const abis = [...new Set(liste.map((z) => /^lib\/([^/]+)\//.exec(z)?.[1]).filter(Boolean))]
pruefe(abis.length === 1 && abis[0] === 'arm64-v8a', 'only arm64-v8a', `ABIs in the package: ${abis.join(' ') || 'none'}, expected only arm64-v8a`)
const arbeit = mkdtempSync(join(tmpdir(), 'lu-paket-'))
try {
  sh('unzip', ['-o', '-q', apk, 'lib/arm64-v8a/*', '-d', arbeit])
  const libDir = join(arbeit, 'lib/arm64-v8a')
  const libs = existsSync(libDir) ? readdirSync(libDir).filter((n) => n.endsWith('.so')).map((n) => join(libDir, n)) : []
  const dist = resolve(process.env.LU_RELEASE_DIST ?? join(WURZEL, 'dist'))
  const r = sh(join(HIER, 'pruefe-testhaken.sh'), [dist, ...libs])
  process.stdout.write(r.aus)
  if (!r.ok) fehler += 1
  // 5b. TEST-LOGIN (3.1.3): derselbe Waechter wie in release.yml fuer die Desktop-Bauten. Das APK
  // baut kein Workflow, also prueft es hier: keine Spur des Testbau-Eingangs in Bibliothek und Seite.
  const tl = sh(join(WURZEL, 'scripts/check-no-test-login.sh'), [dist, ...libs])
  pruefe(libs.length > 0 && tl.ok, 'no trace of the test login (scripts/check-no-test-login.sh)', `the test login is in this package: ${(tl.aus || '').trim().split('\n').slice(1).join(' ')}`)
  // 5c. Keine Pfade des Baurechners im Programm (r49, N2): der Heimordner, und mit ihm der
  // Benutzername, steht in keiner nativen Bibliothek. pfade_umschreiben (_gemeinsam.sh) schreibt
  // sie beim Bau um; fehlt das, stehen hier die Quellpfade von Cargo, rustup und llama.cpp.
  const heim = Buffer.from(`${homedir().replace(/\/+$/, '')}/`)
  const mitHeim = libs.filter((lib) => readFileSync(lib).includes(heim)).map((lib) => lib.split('/').pop())
  pruefe(libs.length > 0 && mitHeim.length === 0, 'no build path of this machine (home folder, user name) in the native library', `the native library names the home folder of this machine (${mitHeim.join(' ')}): the build paths were not rewritten (pfade_umschreiben in _gemeinsam.sh)`)
} finally {
  rmSync(arbeit, { recursive: true, force: true })
}

// 5a. Der lange Produktname steht nicht im Paket: `strings` ueber jede Datei von APK und AAB,
// erlaubt sind nur die internen Stellen aus name-im-paket.erlaubt (mobile-docs/r19/name-im-programm.md).
{
  const r = sh(join(HIER, 'pruefe-name-im-paket.sh'), [apk, aab].filter((p) => p && existsSync(p)))
  process.stdout.write(r.aus)
  if (!r.ok) fehler += 1
}

// 5b. 16-KB-Seiten: jede native Bibliothek im APK und im AAB laedt auf einem Geraet mit
// 16-KB-Speicherseiten (Pflicht bei Google Play fuer Ziel Android 15 und neuer). Gilt auch
// fuer das offene Paket: ein solches Geraet startet die App sonst nicht.
for (const paket of [apk, aab].filter((p) => p && existsSync(p))) {
  for (const z of bericht16kb(paket).zeilen) {
    if (z.ok === null) console.log(`[package] note  ${z.text}`)
    else pruefe(z.ok, z.text, z.text)
  }
}

// 6. Das AAB: da, signiert, mit demselben Zertifikat, nur arm64-v8a.
if (aab) {
  const arbeitAab = mkdtempSync(join(tmpdir(), 'lu-aab-'))
  if (!existsSync(aab)) fail(`no bundle at ${aab}`)
  else {
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin') : null
    const keytool = java && existsSync(join(java, 'keytool')) ? join(java, 'keytool') : 'keytool'
    // keytool schreibt in der Sprache des Systems ("Eigentuemer:" statt "Owner:"). Auf einem
    // deutschen Mac meldete die Pruefung deshalb ein signiertes AAB als unsigniert (Probelauf
    // 10.10.2026). Die Sprache steht hier fest, die Ausgabe wird englisch gelesen.
    const k = sh(keytool, [...ENGLISCH, '-printcert', '-jarfile', aab])
    const aabDn = /Owner: (.*)/.exec(k.aus)?.[1]?.trim() ?? ''
    const aabSha = (/SHA256: ([0-9A-F:]+)/.exec(k.aus)?.[1] ?? '').replace(/:/g, '').toLowerCase()
    pruefe(k.ok && !!aabDn, 'the bundle is signed', 'the bundle (AAB) carries no signature. Google Play refuses an unsigned bundle')
    if (aabDn) pruefe(!PLATZHALTER_DN.test(aabDn), 'the bundle is signed with a real certificate', `throwaway signature on the bundle: "${aabDn}"`)
    if (aabSha && e.signatur?.sha256) pruefe(aabSha === e.signatur.sha256.toLowerCase(), 'bundle and APK carry the same certificate', 'bundle and APK are signed with different certificates')
    const inhalt = sh('unzip', ['-Z1', aab]).aus.split('\n')
    const aabAbis = [...new Set(inhalt.map((z) => /^base\/lib\/([^/]+)\//.exec(z)?.[1]).filter(Boolean))]
    pruefe(aabAbis.length === 1 && aabAbis[0] === 'arm64-v8a', 'bundle: only arm64-v8a', `ABIs in the bundle: ${aabAbis.join(' ') || 'none'}, expected only arm64-v8a`)
    pruefe(inhalt.includes('base/manifest/AndroidManifest.xml') && inhalt.includes('BundleConfig.pb'), 'bundle has a base module', 'the file is not an Android App Bundle (no base module)')
    // Die Signatur ist nicht nur da, sie gilt: jede Datei des Bundles ist von ihr gedeckt.
    const jarsigner = java && existsSync(join(java, 'jarsigner')) ? join(java, 'jarsigner') : 'jarsigner'
    const v = sh(jarsigner, [...ENGLISCH, '-verify', aab])
    pruefe(v.ok && /^jar verified\./m.test(v.aus), 'the signature of the bundle is valid (jarsigner -verify)', `the signature of the bundle does not verify: ${v.aus.trim().split('\n')[0] || 'jarsigner did not run'}`)
    // Kennung, Version und Baunummer stehen im Bundle selbst, im Manifest des Basismoduls. Es
    // liegt dort im Proto-Format; aapt2 liest es, wenn Manifest und Ressourcentabelle wie in
    // einem Proto-APK nebeneinander liegen. bundletool braucht es dafuer nicht.
    const proto = join(arbeitAab, 'proto.apk')
    sh('unzip', ['-o', '-q', '-j', aab, 'base/manifest/AndroidManifest.xml', 'base/resources.pb', '-d', arbeitAab])
    sh('zip', ['-q', '-j', proto, join(arbeitAab, 'AndroidManifest.xml'), join(arbeitAab, 'resources.pb')])
    const aapt2 = aapt2Pfad()
    const x = aapt2 ? sh(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', proto]) : { ok: false, aus: '' }
    const kopf = x.aus.slice(0, x.aus.indexOf('E: uses-sdk') > 0 ? x.aus.indexOf('E: uses-sdk') : 2000)
    const attr = (name) => new RegExp(`A: (?:[^\\s]*:)?${name}(?:\\([^)]*\\))?=(?:"([^"]*)"|(\\S+))`).exec(kopf)?.slice(1).find(Boolean) ?? null
    if (!x.ok || !/E: manifest/.test(x.aus)) fail(`the manifest of the bundle could not be read (${aapt2 ? 'aapt2 dump xmltree' : 'aapt2 not found under ANDROID_HOME/build-tools'}): version and package name of the bundle are not checked`)
    else {
      pruefe(attr('package') === soll.kennung, `bundle: package name ${attr('package')}`, `bundle: package name is ${attr('package')}, the configuration says ${soll.kennung}`)
      pruefe(attr('versionName') === version, `bundle: versionName ${version}`, `wrong version: the bundle carries versionName ${attr('versionName')}, expected ${version}`)
      pruefe(attr('versionCode') === String(code), `bundle: versionCode ${code}`, `wrong version: the bundle carries versionCode ${attr('versionCode')}, expected ${code}`)
      pruefe(!/A: [^\n]*debuggable[^\n]*=(?:true|\(type 0x12\)0xffffffff)/.test(x.aus), 'bundle: not debuggable', 'the bundle is debuggable')
    }
  }
  rmSync(arbeitAab, { recursive: true, force: true })
}

console.log(fehler ? `[package] ${fehler} check(s) failed. This package must not be published.` : PROBE ? '[package] all checks passed, FOR A PROBE. This package must not be published: it comes from a probe run of the release scripts.' : '[package] all checks passed.')
process.exit(fehler ? 1 : 0)
