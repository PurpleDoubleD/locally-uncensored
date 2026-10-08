// Cross-repository release guard. No network, credentials or output artifacts.
// Usage: node scripts/check-cloud-sales.mjs /absolute/path/to/web
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import ts from 'typescript'
import { JSDOM } from 'jsdom'

const webRoot = process.argv[2]
assert.ok(webRoot && isAbsolute(webRoot), 'Pass the absolute web repository path')
const readWeb = (path) => readFileSync(resolve(webRoot, path), 'utf8')
function source(path) {
  return ts.createSourceFile(path, readWeb(path), ts.ScriptTarget.Latest, true)
}
function objects(file) {
  const out = []
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const row = {}
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const value = prop.initializer
        // Ein Schluessel wie 'hosted-max' kommt als Quelltext MIT Anfuehrungs-
        // zeichen zurueck. Ohne das Abstreifen findet keine Suche ihn wieder.
        const key = prop.name.getText(file).replace(/^['"`]|['"`]$/g, '')
        if (ts.isStringLiteral(value)) row[key] = value.text
        if (ts.isNumericLiteral(value)) row[key] = Number(value.text.replaceAll('_', ''))
      }
      out.push(row)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

// Jede Kundenseite unter docs/, einmal eingesammelt.
function docsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`
    if (statSync(path).isDirectory()) docsFiles(path, out)
    else if (/\.(html|txt|md)$/.test(entry)) out.push(path)
  }
  return out
}
const docsRoot = new URL('../docs', import.meta.url).pathname

const page = new JSDOM(readFileSync(new URL('../docs/cloud/index.html', import.meta.url), 'utf8')).window.document
const catalog = objects(source('apps/web/lib/chat/tier-models.ts'))
for (const element of page.querySelectorAll('[data-model-id]')) {
  const entry = catalog.find((item) => item.id === element.dataset.modelId)
  assert.ok(entry, `Model missing from catalog: ${element.dataset.modelId}`)
  assert.equal(element.textContent, entry.label)
}
const flashModel = page.querySelector('[data-model-id]')
assert.equal(catalog.find((item) => item.id === flashModel.dataset.modelId).usageClass, 'flash')
const allowanceSource = source('apps/web/lib/chat/flash-allowance.ts')
let daily
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(allowanceSource) === 'FLASH_DAILY_TOKENS') {
    assert.ok(node.initializer && ts.isNumericLiteral(node.initializer))
    daily = Number(node.initializer.text.replaceAll('_', ''))
  }
  ts.forEachChild(node, visit)
}
visit(allowanceSource)
assert.equal(Number(page.querySelector('[data-flash-limit]').dataset.flashLimit), daily)
assert.ok(page.querySelector('[data-flash-limit]').textContent.startsWith(daily.toLocaleString('en-US')))
const pack = page.querySelector('[data-pack-id]')
const catalogPack = objects(source('apps/web/lib/billing/topup.ts')).find((item) => item.id === pack.dataset.packId)
assert.ok(catalogPack)
assert.equal(Number(pack.dataset.eurCents), catalogPack.eurCents)
assert.equal(Number(pack.dataset.credits), catalogPack.credits)
assert.equal(pack.textContent, `EUR ${catalogPack.eurCents / 100} for ${catalogPack.credits.toLocaleString('en-US')} credits`)
console.log('Cloud sales guard passed: model IDs/labels, Flash membership/limit and pack price/credits match the web source.')

// ── /pricing/ auf locallyuncensored.com ──────────────────────────────
//
// Die Seite nennt Zahlen, die alle im Web-Repo stehen. Sie darf nicht selbst
// entscheiden, was ein Plan kostet, und sie darf nicht stehen bleiben, wenn
// dort etwas anderes beschlossen wird. Jede Zahl der Seite wird hier gegen
// ihre Quelle gehalten: Plaene, Guthaben, Pakete, das Tagesbudget und die
// Anzahl der Modelle, die ohne Ablehnung antworten.
const pricingRaw = readFileSync(new URL('../docs/pricing/index.html', import.meta.url), 'utf8')
const pricing = new JSDOM(pricingRaw).window.document
const tiers = objects(source('apps/web/lib/pricing.ts'))
const tierCredits = objects(source('apps/web/lib/billing/credits.ts'))
  .find((row) => typeof row.hosted === 'number' && typeof row['hosted-max'] === 'number')
assert.ok(tierCredits, 'TIER_CREDITS not found in credits.ts')

for (const cell of pricing.querySelectorAll('[data-plan-id]')) {
  const tier = tiers.find((row) => row.id === cell.dataset.planId)
  assert.ok(tier, `Plan missing from pricing.ts: ${cell.dataset.planId}`)
  assert.equal(Number(cell.dataset.monthlyEur), tier.monthlyEUR, `${tier.id}: monthly price drift`)
  assert.equal(cell.textContent, `EUR ${tier.monthlyEUR}`)
  const row = cell.closest('[data-plan-row]')
  const annual = row.querySelector('[data-annual-eur]')
  assert.equal(Number(annual.dataset.annualEur), tier.annualEUR, `${tier.id}: annual price drift`)
  assert.equal(annual.textContent, `EUR ${tier.annualEUR}`)
  const credits = row.querySelector('[data-plan-credits]')
  assert.equal(Number(credits.dataset.planCredits), tierCredits[cell.dataset.planId], `${tier.id}: credit drift`)
  assert.equal(credits.textContent, tierCredits[cell.dataset.planId].toLocaleString('en-US'))
}
assert.equal(pricing.querySelectorAll('[data-plan-id]').length, tiers.filter((t) => typeof t.monthlyEUR === 'number').length,
  'Every paid plan must appear on the pricing page, and nothing else')

// Nur was VERKAUFT wird. topup.ts fuehrt daneben RETIRED_PACKS: Stufen, die
// es einmal gab und die lesbar bleiben muessen, damit eine alte Buchung nicht
// ins Leere zeigt. Wer sie mitzaehlt, verlangt von der Preisseite, dass sie
// eingestellte Pakete anbietet, und rechnet sie unten in den Abo-Faktor.
const verkaeuflich = (row) =>
  typeof row.credits === 'number' && typeof row.eurCents === 'number' && row.retiredOn === undefined
const packs = objects(source('apps/web/lib/billing/topup.ts')).filter(verkaeuflich)
for (const span of pricing.querySelectorAll('[data-pack-id]')) {
  const entry = packs.find((row) => row.id === span.dataset.packId)
  assert.ok(entry, `Pack missing from topup.ts: ${span.dataset.packId}`)
  assert.equal(Number(span.dataset.eurCents), entry.eurCents)
  assert.equal(Number(span.dataset.credits), entry.credits)
  assert.equal(span.textContent, `EUR ${entry.eurCents / 100} for ${entry.credits.toLocaleString('en-US')} credits`)
}
assert.equal(pricing.querySelectorAll('[data-pack-id]').length, packs.length, 'Every pack must appear, and nothing else')

// Das Handbuch-Kapitel zu LU Cloud nennt dasselbe Tagesbudget mit demselben
// Anker und haengt hier an derselben Quelle wie die beiden Verkaufsseiten.
const handbookCloud = new JSDOM(readFileSync(new URL('../docs/guide/cloud/index.html', import.meta.url), 'utf8')).window.document
// Jede genannte Zahl haengt am Anker, nicht nur die erste der Seite: das
// Handbuch nennt die Decke dreimal, einmal im eigenen Satz und zweimal in
// zitierten Bildschirmtexten.
let flashAnchors = 0
for (const doc of [pricing, page, handbookCloud]) {
  const limits = doc.querySelectorAll('[data-flash-limit]')
  assert.ok(limits.length > 0, 'flash allowance anchor missing')
  for (const limit of limits) {
    assert.equal(Number(limit.dataset.flashLimit), daily, 'flash allowance drift')
    assert.ok(limit.textContent.startsWith(daily.toLocaleString('en-US')))
    flashAnchors += 1
  }
}
// Die Anzahl der Flash-Modelle war als Wort getippt und von nichts bewacht.
const flashInCatalog = catalog.filter((row) => row.usageClass === 'flash').length
const flashCount = pricing.querySelector('[data-flash-model-count]')
assert.ok(flashCount, 'docs/pricing/index.html: the Flash model count carries no anchor')
assert.equal(Number(flashCount.dataset.flashModelCount), flashInCatalog, 'flash model count drift')
assert.equal(flashCount.textContent, String(flashInCatalog), 'flash model count text drift')
assert.ok(
  !/\b(Twelve|Eleven|Thirteen) models are in that class/i.test(pricingRaw),
  'docs/pricing/index.html: the Flash model count is typed out again instead of anchored',
)
console.log(`Flash guard passed: ${flashAnchors} anchored mentions of the ${daily.toLocaleString('en-US')} ceiling and ${flashInCatalog} Flash models, all from the web source.`)

// Die gemessene Zahl. Sie steht als Verkaufsargument auf der Seite, also darf
// sie nur so lange dort stehen, wie der Katalog sie hergibt.
const catalogSize = catalog.filter((row) => typeof row.inM === 'number' && typeof row.outM === 'number').length
const unfilteredFull = catalog.filter((row) => row.unfiltered === 'full').length
// Beide Verkaufsseiten nennen denselben Satz Zahlen, also haengen beide hier.
// Eine Seite allein zu aendern war bisher moeglich, weil nur die Preisseite
// geprueft wurde.
const zahlenseiten = [['docs/pricing/index.html', pricing], ['docs/cloud/index.html', page]]
// Entscheid David R6-5 vom 12.09.2026: die Marke traegt nur, was in BEIDEN
// Laeufen nach der strengen Regel `full` war. Das sind 24, hergeleitet in
// e2e/6-nachlauf/marken-nachmessung.md, Abschnitt 13.2 und Zeile "Sicher
// `full` nach strenger Regel in beiden Laeufen | 24". Die Zahl steht hier
// ausgeschrieben, weil sie ein Entscheid ist und keine Ableitung; abgeleitet
// wird, was sie darf.
// Entscheid David vom 05.10.2026: fuenf der 24 haben im Drei-Runden-Test in
// Runde zwei oder drei abgelehnt und tragen die Marke nicht mehr, seither 19
// (Bericht lu-305/mail/MARKIERUNGEN-TEST-2026-10-05.md).
const MARKED_MODELS = 19
// Strenger lesen kann die Menge nur verkleinern: ein Modell, das die lockere
// Regel schon durchfallen liess, kommt unter der strengen nicht dazu. Sinkt
// `unfiltered: 'full'` im Katalog unter die Entscheidzahl, ist der Entscheid
// ueberholt und diese Zeile rot, statt dass die Seite mehr verspricht als
// die Messung hergibt.
assert.ok(
  MARKED_MODELS <= unfilteredFull,
  `the mark decision claims ${MARKED_MODELS} models, the catalogue only carries ${unfilteredFull} unfiltered ones`,
)
for (const [name, doc] of zahlenseiten) {
  const claimed = doc.querySelector('[data-unfiltered-count]')
  assert.ok(claimed, `${name}: unfiltered count anchor missing`)
  assert.equal(Number(claimed.dataset.unfilteredCount), MARKED_MODELS, `${name}: unfiltered count drift`)
  assert.equal(claimed.textContent, String(MARKED_MODELS), `${name}: unfiltered count text drift`)
  const claimedTotal = doc.querySelector('[data-catalog-count]')
  assert.ok(claimedTotal, `${name}: catalog count anchor missing`)
  assert.equal(Number(claimedTotal.dataset.catalogCount), catalogSize, `${name}: catalog size drift`)
  assert.equal(claimedTotal.textContent, String(catalogSize), `${name}: catalog size text drift`)
}
// Gemessen wurde am 10.09.2026; ein Modell kam danach in den Katalog. Die
// Seite darf "27 von N" nur mit dem N sagen, das der Messlauf wirklich hatte,
// und das steht in der Messtabelle: die Zeilen VOR der Zaehlzeile.
const factsTable = readWeb('apps/web/lib/chat/model-facts.md').split('\nCounts:')[0]
const measuredSize = factsTable.split('\n').filter((line) => /^\|\s*\S+\/\S+\s*\|\s*(full|partial|none|unknown)\s*\|/.test(line)).length
assert.ok(measuredSize > 40 && measuredSize <= catalogSize, `measured set ${measuredSize} out of range`)
for (const [name, doc] of zahlenseiten) {
  const claimedMeasured = doc.querySelector('[data-measured-count]')
  assert.ok(claimedMeasured, `${name}: measured count anchor missing`)
  assert.equal(Number(claimedMeasured.dataset.measuredCount), measuredSize, `${name}: measured size drift`)
  assert.equal(claimedMeasured.textContent, String(measuredSize), `${name}: measured size text drift`)
}
// Ein Satz, ueberall zeichengleich. Die Zahlen darin kommen aus dem Entscheid
// und aus der Messtabelle, der Wortlaut aus dem Entscheid selbst. Geprueft
// wird gegen den Text OHNE Auszeichnung, damit die Anker den Vergleich nicht
// verstecken: jede Stelle in docs/, die ein Verhaeltnis von Chatmodellen
// nennt, muss genau dieser Satz sein.
const MARK_SENTENCE =
  `${MARKED_MODELS} of the ${measuredSize} cloud chat models we measured answer in full without refusing, and only those carry the No refusals mark.`
// Die Beschreibung im Kopf ist Kundentext wie der Fliesstext, steht aber IN
// einem Element. Ohne das Herausziehen faellt sie beim Entfernen der
// Auszeichnung weg, und genau dort stand der Satz mit der alten Zahl.
const plainText = (raw) =>
  raw.replace(/<meta[^>]*content="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"')
const markRatio = /\b\d+ (?:of the \d+ )?(?:cloud )?(?:measured )?chat models (?:we measured |that )?answer[^.]*\./g
const markOffences = []
for (const file of docsFiles(docsRoot)) {
  for (const hit of plainText(readFileSync(file, 'utf8')).match(markRatio) ?? []) {
    if (hit !== MARK_SENTENCE) markOffences.push(`${file.slice(docsRoot.length - 4)}: ${hit}`)
  }
}
assert.equal(
  markOffences.length,
  0,
  `every mark ratio in docs/ has to read as the decision writes it: ${markOffences.length} deviation(s) [${markOffences.join(' | ')}]`,
)
const markSentences = docsFiles(docsRoot)
  .map((file) => (plainText(readFileSync(file, 'utf8')).match(markRatio) ?? []).length)
  .reduce((a, b) => a + b, 0)
assert.ok(markSentences >= 3, `the mark sentence stands in ${markSentences} place(s) in docs/, expected at least 3`)
console.log(`Denominator guard passed: ${MARKED_MODELS} of ${measuredSize} measured and ${catalogSize} in the catalogue, identical on ${zahlenseiten.length} sales pages, and the mark sentence is word-identical in ${markSentences} place(s).`)
// ── Der Wolkenschalter im Desktop ────────────────────────────────────
//
// Die Oberflaeche zeigt diese Zahlen, BEVOR jemand angemeldet ist, also bevor
// es einen Katalog zu lesen gibt. Sie stehen deshalb fest in
// src/lib/cloud-pitch.ts, und hier haengen sie an ihrer Quelle. Ein Schalter,
// der eine Zahl verspricht, die der Katalog nicht mehr hergibt, ist eine
// Falschaussage im Kaufmoment.
const pitchSource = ts.createSourceFile(
  'cloud-pitch.ts',
  readFileSync(new URL('../src/lib/cloud-pitch.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)
const pitch = objects(pitchSource).find((row) => typeof row.chatModels === 'number')
assert.ok(pitch, 'CLOUD_PITCH not found in cloud-pitch.ts')
const mediaSource = source('apps/web/lib/render/cloud-models.ts')
const mediaRows = objects(mediaSource).filter((row) => typeof row.id === 'string' && typeof row.kind === 'string')
// `ops`-Eintraege sind Sondermodelle (Lipsync, Extend, Training), keine
// Auswahleintraege. Die Zaehlung der Seite meint die Auswahl.
const opsIds = new Set(
  mediaSource.getFullText().split('\n')
    .filter((line) => /ops: \[/.test(line))
    .map((line) => /id: '([^']+)'/.exec(line)?.[1])
    .filter(Boolean),
)
const countKind = (kind) => mediaRows.filter((row) => row.kind === kind && !opsIds.has(row.id)).length
assert.equal(pitch.chatModels, catalogSize, 'pitch: chat model count drift')
assert.equal(pitch.measuredChatModels, measuredSize, 'pitch: measured set drift')
assert.equal(pitch.unfilteredChatModels, unfilteredFull, 'pitch: unfiltered count drift')
assert.equal(pitch.flashModels, catalog.filter((row) => row.usageClass === 'flash').length, 'pitch: flash count drift')
assert.equal(pitch.flashDailyTokens, daily, 'pitch: daily ceiling drift')
assert.equal(pitch.imageModels, countKind('image'), 'pitch: image model count drift')
// Absichtliche Abweichung: der Desktop nennt die volle Katalogliste, die
// Kaufseite auf lu-labs.ai nennt weniger. publicMediaModels filtert dort ueber
// keptOffThisDomain (apps/web/app/(marketing)/pricing/pricing-detail.ts), weil
// die erwachsenenfaehigen Videoendpunkte auf der Zahlungsdomain nicht beworben
// werden. Hier wird deshalb gegen die UNGEFILTERTE Liste geprueft, und das ist
// kein Versehen. Ob der Desktop weiter die volle Zahl nennen soll, waehrend
// die Kaufseite eine kleinere nennt, ist Entscheid David.
assert.equal(pitch.videoModels, countKind('video'), 'pitch: video model count drift')
console.log(`Cloud switch guard passed: ${pitch.unfilteredChatModels}/${pitch.chatModels} chat, ${pitch.flashModels} flash, ${pitch.imageModels} image and ${pitch.videoModels} video match the web catalogue.`)

console.log(`Pricing guard passed: ${tiers.filter((t) => typeof t.monthlyEUR === 'number').length} plans, ${packs.length} packs, ${unfilteredFull}/${catalogSize} models and the ${daily.toLocaleString('en-US')} token ceiling match the web source.`)

// ── Die sechs Erwachsenen-Videomodelle auf der LUC-Preisseite ────────
//
// Entscheid David (R3-8, 12.09.2026): die sechs Endpunkte ohne eingebaute
// Inhaltsbeschraenkung stehen mit Namen und Credit-Preis je Clip auf der
// LUC-Preisseite. lu-labs.ai bleibt unberuehrt; dort haelt keptOffThisDomain
// sie weiter von der Zahlungsdomain fern, und genau deshalb darf diese Seite
// nicht von der Kaufseite abgeschrieben werden. Namen und Preise kommen aus
// dem Katalog: cloud-models.ts liefert Id und Etikett, credits.ts den
// Dollarsatz und den Credit-Kurs. Eine Tokenmenge je Geld steht nirgends.
const mediaText = mediaSource.getFullText()
const adultVideo = mediaText.split('\n')
  .filter((line) => /kind: 'video'/.test(line) && /adult: true/.test(line) && !/ops: \[/.test(line))
  .map((line) => ({ id: /id: '([^']+)'/.exec(line)?.[1], label: /label: '([^']+)'/.exec(line)?.[1] }))
assert.ok(adultVideo.length > 0 && adultVideo.every((row) => row.id && row.label), 'adult video rows unreadable')
const creditsText = readWeb('apps/web/lib/billing/credits.ts')
const creditUsd = Number(/export const CREDIT_USD = ([0-9.e-]+)/.exec(creditsText)?.[1])
assert.ok(creditUsd > 0, 'CREDIT_USD not found in credits.ts')
const priceTable = /export const MEDIA_MODEL_USD[^{]*\{([\s\S]*?)\n\}/.exec(creditsText)?.[1]
assert.ok(priceTable, 'MEDIA_MODEL_USD not found in credits.ts')
const clipPrice = (id) => {
  const hit = new RegExp(`'${id.replaceAll('.', '\\.')}': \\{ base: ([0-9.]+)(, long: ([0-9.]+))?`).exec(priceTable)
  assert.ok(hit, `no base price for ${id} in MEDIA_MODEL_USD`)
  return { base: Number(hit[1]), long: hit[3] === undefined ? undefined : Number(hit[3]) }
}
const adultRows = [...pricing.querySelectorAll('[data-adult-video-row]')]
assert.equal(
  adultRows.length,
  adultVideo.length,
  `docs/pricing/index.html: the page lists ${adultRows.length} adult video models, the catalogue has ${adultVideo.length}`,
)
// Entscheid David vom 08.10.2026: die Anzeigenamen dieser Endpunkte heissen
// "Uncensored". Er loest den Entscheid vom 13.09.2026 ab. Verglichen wird die
// volle Beschriftung; das Markenwort wird zusaetzlich gegen den Entscheid
// geprueft, nicht nur gegen das Web. Auf der Zahlungsdomain taucht keiner
// dieser Endpunkte auf (Entscheid dbf663fe).
const MARKENWORT = 'Uncensored'
adultVideo.forEach((model, index) => {
  const row = adultRows[index]
  const name = row.querySelector('[data-adult-model-id]')
  assert.ok(name, `docs/pricing/index.html: adult video row ${index + 1} carries no model anchor`)
  assert.equal(name.dataset.adultModelId, model.id, `docs/pricing/index.html: adult video id drift in row ${index + 1}`)
  assert.equal(name.textContent, model.label,
    `docs/pricing/index.html: adult video label drift for ${model.id}`)
  assert.ok(name.textContent.includes(MARKENWORT),
    `docs/pricing/index.html: ${model.id} does not carry the decided word ${MARKENWORT}`)
  assert.ok(!/\bOpen\b/.test(name.textContent),
    `docs/pricing/index.html: ${model.id} still carries the withdrawn word Open`)
  const cell = row.querySelector('[data-clip-credits]')
  assert.ok(cell, `docs/pricing/index.html: no clip price anchor for ${model.id}`)
  const price = clipPrice(model.id)
  const credits = Math.ceil(price.base / creditUsd)
  assert.equal(Number(cell.dataset.clipCredits), credits, `docs/pricing/index.html: clip price drift for ${model.id}`)
  assert.equal(cell.textContent, credits.toLocaleString('en-US'), `docs/pricing/index.html: clip price text drift for ${model.id}`)
  // Der Satz daneben sagt "five seconds, no eight second option". Er haengt
  // daran, dass die sechs in der Preistabelle keinen 8-Sekunden-Satz haben;
  // clipLengths blendet den Knopf genau daran aus (R3-8).
  assert.equal(price.long, undefined, `docs/pricing/index.html: ${model.id} now has an 8s rate, the five-second sentence is stale`)
})
assert.ok(
  /renders a clip of five seconds/.test(pricingRaw),
  'docs/pricing/index.html: the adult video block no longer states the clip length it prices',
)
console.log(`Adult video guard passed: ${adultRows.length} endpoints with catalogue names and ${adultRows.map((r) => r.querySelector('[data-clip-credits]').dataset.clipCredits).join('/')} credits per five second clip, all from the web source.`)
// ── Die zwoelf Motoren, Name fuer Name ──────────────────────────────
//
// Die Anzahl stimmte schon, der zwoelfte Name nicht: die Sprachmodell-Dateien
// fuehrten TGI, der Erkennungslauf kennt text-generation-webui. Zwei
// verschiedene Produkte. Geprueft wird deshalb jeder Name gegen LOCAL_BACKENDS
// in der Ersteinrichtung, nicht die Anzahl.
const backendsStep = readFileSync(new URL('../src/components/onboarding/BackendsStep.tsx', import.meta.url), 'utf8')
const backendNames = [...backendsStep.matchAll(/name: '([^']+)',\s+description:/g)].map((treffer) => treffer[1])
assert.ok(backendNames.length >= 12, `LOCAL_BACKENDS not read: ${backendNames.length} names`)
const backendDrift = []
for (const datei of ['llms.txt', 'llms-full.txt']) {
  const text = readFileSync(new URL(`../docs/${datei}`, import.meta.url), 'utf8')
  const liste = /auto-detected \(([^)]+)\)|auto-detects \d+ local backends: (.+?)\. ComfyUI/.exec(text)
  assert.ok(liste, `docs/${datei}: the backend list is gone`)
  const genannt = (liste[1] ?? liste[2]).split(/,\s*|\s+and\s+/).map((name) => name.trim()).filter(Boolean)
  for (const name of genannt) if (!backendNames.includes(name)) backendDrift.push(`${datei}: ${name}`)
  for (const name of backendNames) if (!genannt.includes(name)) backendDrift.push(`${datei}: missing ${name}`)
}
assert.equal(
  backendDrift.length,
  0,
  `The engine names come from LOCAL_BACKENDS: ${backendDrift.length} difference(s) [${backendDrift.join(', ')}]`,
)
console.log(`Backend guard passed: both language-model files name the same ${backendNames.length} engines as LOCAL_BACKENDS.`)

// ── Eine Installergroesse fuer den ganzen Baum ──────────────────────
//
// Gemessen wurde bei jedem Bau: der Installerbericht zu 3.0.0 nennt
// Locally Uncensored_3.0.0_x64-setup.exe mit 14.075.397 Bytes. Im Repo haelt
// das Handbuch diese Zahl, und es ist die einzige docs/-Datei, die fuer 3.0.0
// geschrieben wurde. Jede Seite, die eine Installergroesse nennt, nennt diese.
const installGuide = readFileSync(new URL('../docs/guide/install/index.html', import.meta.url), 'utf8')
const installerMB = Number(/about (\d+) MB on Windows/.exec(installGuide)?.[1])
assert.ok(Number.isFinite(installerMB), 'docs/guide/install/index.html: the installer size is gone')
const installerDrift = []
for (const path of docsFiles(docsRoot)) {
  for (const claim of readFileSync(path, 'utf8').match(/~\s?\d+ MB installer/g) ?? []) {
    if (Number(/\d+/.exec(claim)[0]) !== installerMB) installerDrift.push(`${path.slice(docsRoot.length + 1)}: ${claim}`)
  }
}
assert.equal(
  installerDrift.length,
  0,
  `The handbook measures the installer at ${installerMB} MB, so every page says that: ${installerDrift.length} page(s) disagree [${installerDrift.join(', ')}]`,
)
console.log(`Installer guard passed: every "MB installer" claim in docs/ says ${installerMB} MB, the size the handbook carries.`)

// ── Der Mac, einmal beantwortet ─────────────────────────────────────
//
// Das Handbuch ist die einzige docs/-Flaeche, die fuer 3.0.0 geschrieben
// wurde, und es sagt: es gibt keinen Mac-Bau und hat nie einen gegeben. Keine
// andere Seite darf daneben eine Roadmap versprechen. Der Anker ist der Satz
// im Handbuch: verschwindet er, faellt auch diese Pruefung auf.
const startseite = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8')
const macAnswer = readFileSync(new URL('../docs/guide/faq-and-glossary/index.html', import.meta.url), 'utf8')
assert.ok(
  macAnswer.includes('There is no Mac build and there has never been one'),
  'docs/guide/faq-and-glossary/index.html: the Mac answer drifted',
)
const macRoadmapClaims = []
for (const path of docsFiles(docsRoot)) {
  const text = readFileSync(path, 'utf8')
  for (const satz of text.split(/(?<=[.!?])["\s]|\n/)) {
    if (/roadmap/i.test(satz) && /\bmac(os)?\b/i.test(satz)) macRoadmapClaims.push(`${path.slice(docsRoot.length + 1)}: ${satz.trim().slice(0, 70)}`)
  }
}
assert.equal(
  macRoadmapClaims.length,
  0,
  `The handbook says there has never been a Mac build, so no page may put one on a roadmap: ${macRoadmapClaims.length} claim(s) [${macRoadmapClaims.join(' | ')}]`,
)
// Die Startseite hat den Mac ausserdem als behobenen Fehler gefuehrt. Jede
// Stelle, die den Mac nennt, muss im selben Satz sagen, dass es den Bau nicht
// gibt, sonst liest die Startseite sich wie eine Plattformzusage. Ein Bau
// gaebe es an einem .dmg zu erkennen, und das kommt im ganzen Baum nicht vor.
const macMentions = []
for (const satz of startseite.split(/(?<=[.!?])["\s]|\n/)) {
  if (!/\bmac(os)?\b/i.test(satz.replace(/machine/gi, ''))) continue
  // Die Frage selbst darf den Mac nennen, nur die Antwort ist gebunden.
  if (/\?/.test(satz)) continue
  if (/no Mac build|on a Mac, use the hosted studio/i.test(satz)) continue
  macMentions.push(satz.trim().slice(0, 70))
}
assert.equal(
  macMentions.length,
  0,
  `There is no Mac build, so docs/index.html may only say so: ${macMentions.length} other Mac mention(s) [${macMentions.join(' | ')}]`,
)
const dmgClaims = docsFiles(docsRoot).filter((path) => /\.dmg\b|\bdmg\b/i.test(readFileSync(path, 'utf8')))
assert.equal(dmgClaims.length, 0, `No Mac build exists, so docs/ may not offer a .dmg: ${dmgClaims.length} page(s)`)
// Die Fernzugriff-Anleitung endet im Fenster der App, und das laeuft auf
// einem Mac nicht. Eine Installationszeile fuer macOS fuehrt den Leser bis
// Schritt 2 und dann ins Leere.
const remoteAccess = readFileSync(new URL('../docs/remote-access/index.html', import.meta.url), 'utf8')
const macSetupLines = remoteAccess.split('\n').filter((zeile) => /macos/i.test(zeile))
assert.equal(macSetupLines.length, 0, `There is no Mac build, so docs/remote-access/index.html may not carry a macOS setup line: ${macSetupLines.length}`)
for (const platform of ['Windows:', 'Linux:']) {
  assert.ok(remoteAccess.includes(platform), `docs/remote-access/index.html: the ${platform} line is gone`)
}
console.log('Mac guard passed: 0 roadmap promises, 0 stray Mac mentions on the home page, 0 macOS setup lines in the remote-access guide and 0 dmg offers in docs/, and the handbook answer is unchanged.')

// ── Die Startseite verneint nicht, was die Wolkenseite verkauft ─────
//
// docs/cloud/index.html ist die Verkaufsseite fuer LU Cloud auf derselben
// Domain. Solange es sie gibt, darf die Startseite nicht "No cloud" sagen,
// auch nicht im JSON-LD, aus dem Suchmaschinen und Sprachmodelle zitieren.
const cloudPageExists = existsSync(new URL('../docs/cloud/index.html', import.meta.url))
// Ein Satz darf "no cloud" sagen, wenn er die Bedingung mitnennt: im lokalen
// Modus gibt es wirklich keine Wolke. Unbedingt gesagt ist es eine Verneinung
// des eigenen Angebots.
const noCloudClaims = cloudPageExists
  ? ['index.html', 'llms.txt', 'llms-full.txt'].flatMap((datei) =>
      readFileSync(new URL(`../docs/${datei}`, import.meta.url), 'utf8')
        .split(/(?<=[.!?])["\s]|\n/)
        .filter((satz) => /no cloud/i.test(satz) && !/local mode|unless you enable|local embeddings|when you switch it on/i.test(satz))
        .map((satz) => `${datei}: ${satz.trim().slice(-50)}`))
  : []
assert.equal(
  noCloudClaims.length,
  0,
  `docs/cloud/index.html sells hosted models, so the home page may not deny the cloud: ${noCloudClaims.length} unqualified claim(s) [${noCloudClaims.map((satz) => satz.trim().slice(-60)).join(' | ')}]`,
)
console.log('Home page guard passed: 0 unqualified "No cloud" claims on the home page or in the language-model files while docs/cloud/index.html sells hosted models.')

// ── Die zwei Zeilen, die kein Schalter bewegt ───────────────────────
//
// Derselbe Satz steht im Blatt (src/lib/release-notes.ts) und auf der
// Preisseite. Zwei Flaechen, ein Versprechen: sie muessen wortgleich bleiben,
// sonst liest ein Kunde im Fenster etwas anderes als auf der Seite. Der
// Ablehnungsteil wird hier nie schwaecher geprueft, nur gleichgehalten.
const sheet = readFileSync(new URL('../src/lib/release-notes.ts', import.meta.url), 'utf8')
const csamLines = [
  'aterial involving minors is refused on every request',
  'ou may not upload a photograph of a real, identifiable person without their consent',
]
for (const [name, text] of [['docs/pricing/index.html', pricingRaw], ['src/lib/release-notes.ts', sheet]]) {
  for (const line of csamLines) {
    assert.ok(text.includes(line), `${name}: the content-policy line drifted, expected "${line}"`)
  }
}
// "and reported" ist eine Zusage ueber eine Meldung. Der einzige Meldeweg im
// Web ist alertCsamBlock, und der steigt ohne gesetzte SAFETY_ALERT_WEBHOOK_URL
// sofort aus. Solange der Weg an einer Umgebungsvariablen haengt, darf keine
// Seite in docs/ eine Meldung versprechen.
const safetySink = readWeb('apps/web/lib/render/safety.ts')
const alertIsOptional = /SAFETY_ALERT_WEBHOOK_URL/.test(safetySink) && /if \(!url\) return/.test(safetySink)
const reportedClaims = alertIsOptional
  ? docsFiles(docsRoot).filter((path) => /refused on every request and reported/i.test(readFileSync(path, 'utf8')))
  : []
assert.equal(
  reportedClaims.length,
  0,
  `alertCsamBlock returns early without SAFETY_ALERT_WEBHOOK_URL, so no page may promise a report: ${reportedClaims.length} page(s) [${reportedClaims.map((path) => path.slice(docsRoot.length + 1)).join(', ')}]`,
)
console.log('Content-policy guard passed: the two lines are word-identical on the pricing page and in the release sheet, and 0 pages in docs/ promise a report the code cannot make.')

// ── Keine erfundene Tiersperre in docs/ ─────────────────────────────
//
// Der Katalog kennt kein Tier-Feld: die Zeichenkette `tier:` kommt in
// tier-models.ts null Mal vor, und die Datei sagt daneben, dass jede
// Wolkenberechtigung jeden Eintrag erreicht. Solange das so ist, darf kein
// Absatz in docs/ einen Modellnamen aus dem Katalog mit einem Plan als Sperre
// paaren. Beide Wortlisten kommen aus der Quelle: die Modellnamen aus dem
// Katalog, die Plannamen aus TIERS. Vom mehrteiligen Plannamen zaehlt auch das
// unterscheidende Wort allein, weil die Seiten "Pro" schreiben und nicht
// "Hosted Pro".
const catalogHasTierField = /\btier\s*:/.test(readWeb('apps/web/lib/chat/tier-models.ts'))
const planWords = [...new Set(
  tiers
    .filter((row) => typeof row.id === 'string' && typeof row.name === 'string')
    .flatMap((row) => (row.name.includes(' ') ? [row.name, row.name.split(' ').at(-1)] : [row.name])),
)].filter((word) => word !== 'Hosted' && word !== 'Self-Host')
assert.ok(planWords.length > 0, 'No plan names found in pricing.ts')
const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "GLM 5.3" im Katalog, "GLM-5.3" auf der Seite: der Trenner bleibt offen.
const modelPatterns = catalog
  .filter((row) => typeof row.id === 'string' && typeof row.label === 'string')
  .map((row) => ({ label: row.label, re: new RegExp(`\\b${row.label.split(/[\s-]+/).map(escapeForRegExp).join('[\\s-]?')}\\b`, 'i') }))
const planGate = new RegExp(
  `\\b(?:on|for|requires?|needs?|limited to|included in)\\s+(?:the\\s+|a\\s+|an\\s+)?(?:Hosted\\s+)?(?:${planWords.map(escapeForRegExp).join('|')})\\b`
  + `|\\b(?:Hosted\\s+)?(?:${planWords.map(escapeForRegExp).join('|')})\\s+(?:plan|tier|subscribers?|accounts?|only)\\b`,
  'g',
)
const tierGateOffences = []
if (!catalogHasTierField) {
  for (const path of docsFiles(docsRoot)) {
    const raw = readFileSync(path, 'utf8')
    const blocks = path.endsWith('.html')
      ? [...new JSDOM(raw).window.document.querySelectorAll('p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, figcaption, blockquote')].map((node) => node.textContent)
      : raw.split('\n')
    for (const text of blocks) {
      const gates = text.match(planGate)
      if (!gates) continue
      const named = modelPatterns.filter((model) => model.re.test(text))
      if (!named.length) continue
      tierGateOffences.push(`${path.slice(docsRoot.length + 1)}: ${named.map((m) => m.label).join('/')} + "${gates.join('", "')}"`)
    }
  }
}
assert.equal(
  tierGateOffences.length,
  0,
  `The catalogue has no tier field, so no page may put a model behind a plan: ${tierGateOffences.length} pairing(s) [${tierGateOffences.join(' | ')}]`,
)
console.log(`Tier-gate guard passed: 0 model-behind-a-plan claims in docs/, and the catalogue still carries no tier field (plan words: ${planWords.join(', ')}).`)

// ── Vergleichsseiten: kein Gratispfad ───────────────────────────────
//
// `planPays` im Web verlangt seit dem Entscheid V3 vom 12.09.2026 ein
// LAUFENDES Abo: die Funktion nimmt genau ein Argument, den Rang der aktiven
// Lizenz, und antwortet nur fuer die drei Abo-Raenge ja. Solange das so ist,
// darf keine LU-Spalte einer Vergleichsseite einen kostenlosen Flash-Pfad
// versprechen. Gebunden ist hier die Regel, nicht ihr Wortlaut: faellt
// `isSubscriptionTier` aus `planPays` heraus, faellt auch dieses Verbot. Nur
// die letzte Spalte wird geprueft, denn die Gegenseite darf ihren eigenen
// Gratistarif nennen.
const pricingSource = readWeb('apps/web/lib/pricing.ts')
const planPaysArgs = /export function planPays\(([^)]*)\)/.exec(pricingSource)?.[1]
const planPaysBody = /export function planPays\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(pricingSource)?.[1]
assert.ok(planPaysBody !== undefined && planPaysArgs !== undefined, 'planPays not found in pricing.ts')
// Ein zweites Argument waere wieder die Kaufhistorie.
const planPaysArity = planPaysArgs.trim() === '' ? 0 : planPaysArgs.split(',').length
const flashNeedsActivePlan =
  /isSubscriptionTier\(/.test(planPaysBody) && !/paidBefore/.test(planPaysBody) && planPaysArity === 1
const freePathOffences = []

for (const slug of ['ollama-cloud', 'featherless', 'venice', 'chutes', 'infermatic', 'arliai', 'cerebras-code', 'backyard-ai', 'sillyhost']) {
  const comparison = new JSDOM(readFileSync(new URL(`../docs/vs/${slug}/index.html`, import.meta.url), 'utf8')).window.document
  const luFacts = [...comparison.querySelectorAll('[data-comparison-row] td:last-child')].map((cell) => cell.textContent).join(' ')
  assert.ok(luFacts.includes(`EUR ${catalogPack.eurCents / 100} for ${catalogPack.credits.toLocaleString('en-US')} credits`), `${slug}: pack claim drift`)
  assert.ok(luFacts.includes(daily.toLocaleString('en-US')), `${slug}: allowance claim drift`)
  if (flashNeedsActivePlan) {
    for (const hit of luFacts.match(/free Flash|free allowance|competing free/gi) ?? []) {
      freePathOffences.push(`${slug}: "${hit}"`)
    }
  }
  console.log(`${slug}: LU pack and allowance claims match the web source.`)
}

const freePathPages = new Set(freePathOffences.map((entry) => entry.split(':')[0])).size
assert.equal(
  freePathOffences.length,
  0,
  `planPays requires an active paid plan, so no LU column may promise a free Flash path: ${freePathOffences.length} claim(s) on ${freePathPages} page(s) [${freePathOffences.join(', ')}]`,
)
console.log('Comparison guard passed: 0 free-path claims in the LU column of 9 comparison pages, and planPays still requires an active paid plan.')

// ── Entscheid V3: die Freimenge haengt an einem laufenden Abo ───────
//
// Entscheid David vom 12.09.2026 zum Zusatzfund V3: ein einmaliger Pack von
// 5 Euro oeffnet die Freimenge NICHT auf Dauer. Die Bedingung heisst kuenftig
// "laufendes bezahltes Abo", nicht "hat je einmal gezahlt".
//
// Seit dem Merge vom 12.09.2026 traegt der Code die Regel selbst:
// `planPays` (apps/web/lib/pricing.ts) nimmt nur noch den Rang der aktiven
// Lizenz und fragt die Kaufhistorie nicht mehr. Aus der Wortlautschranke ist
// darum wieder eine Codeschranke geworden, und beide stehen nebeneinander:
// die alte Formulierung ist in docs/ verboten, die neue an vier Flaechen
// Pflicht, damit keine Seite den Paketkunden weiter zur Freimenge einlaedt.
const handbookText = readFileSync(new URL('../docs/guide/cloud/index.html', import.meta.url), 'utf8')
const cloudRaw = readFileSync(new URL('../docs/cloud/index.html', import.meta.url), 'utf8')
const homeRaw = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8')
const staleFlashWording = docsFiles(docsRoot).filter((path) =>
  /never paid|paid-plan benefit|is a paid benefit/i.test(readFileSync(path, 'utf8')),
)
assert.equal(
  staleFlashWording.length,
  0,
  `the Flash allowance needs an active plan now, so "has never paid" may not stand in docs/: ${staleFlashWording.length} page(s) [${staleFlashWording.map((path) => path.slice(docsRoot.length + 1)).join(', ')}]`,
)
for (const [name, raw] of [
  ['docs/guide/cloud/index.html', handbookText],
  ['docs/pricing/index.html', pricingRaw],
  ['docs/cloud/index.html', cloudRaw],
  ['docs/index.html', homeRaw],
]) {
  assert.ok(
    /accounts without an active plan keep paying credits/i.test(raw),
    `${name}: the condition an account without an active plan really meets is missing`,
  )
  assert.ok(/on an active paid plan/.test(raw), `${name}: the Flash allowance is not tied to an active plan`)
}
assert.ok(
  !/pack without a plan does not get it/i.test(handbookText),
  'docs/guide/cloud/index.html: say what a pack does instead of only what it does not',
)
assert.ok(
  /a credit pack on its own does not open it/i.test(handbookText),
  'docs/guide/cloud/index.html: the handbook has to say that a pack alone does not open the allowance',
)
// Die Wortlautschranke haengt an einer Codeaussage: faellt die Bedingung des
// laufenden Abos ganz aus planPays heraus, ist der ganze Absatz falsch.
assert.ok(
  flashNeedsActivePlan,
  'planPays no longer requires an active paid plan at all, the whole Flash wording is stale',
)
assert.ok(
  !/paidBefore/.test(pricingSource),
  'planPays reads the purchase history again: the Flash wording in docs/ promises the allowance to a pack buyer',
)
console.log(`Handbook guard passed: 0 pages in docs/ promise the allowance to an account that paid once, 4 surfaces name the active plan, and planPays takes ${planPaysArity} argument, the rank of the active licence.`)

// ── Das Wort Flash ist kein Kriterium ───────────────────────────────
//
// Der Katalog fuehrt Modelle, deren Name Flash enthaelt, die aber kein
// usageClass 'flash' tragen: DeepSeek V4.1 Flash kostet 0,30 ein und 1,20 aus
// je Million. Solange es so einen Eintrag gibt, darf das Handbuch den Namen
// nicht zum Kriterium machen. Der Beleg kommt aus dem Katalog, nicht aus einem
// getippten Modellnamen.
const flashByNameOnly = catalog.filter(
  (row) => typeof row.label === 'string' && /\bflash\b/i.test(row.label) && row.usageClass !== 'flash',
)
if (flashByNameOnly.length > 0) {
  assert.ok(
    !/carry the word Flash/i.test(handbookText),
    `docs/guide/cloud/index.html: ${flashByNameOnly.length} catalogue entr(y/ies) carry Flash in the name without the Flash class, so the name may not be the criterion`,
  )
  assert.ok(
    /The word Flash in a model name does not decide it/i.test(handbookText),
    'docs/guide/cloud/index.html: the sentence that the name does not decide it is missing',
  )
}
console.log(`Flash-class guard passed: the handbook names the class and not the word, with ${flashByNameOnly.length} catalogue entry carrying Flash in the name without the class.`)

// ── Die Marke der Flash-Klasse heisst wieder "No credits" ───────────
//
// Entscheid David vom 12.09.2026 zum Wortlaut, den der Verfasser der
// Logikkontrolle selbst gesetzt hatte: das Etikett heisst nicht "Included",
// sondern wieder "No credits", weil "Included" nicht sagt, worin etwas
// enthalten ist, und der Tooltip daneben ohnehin "No credits" sagte.
//
// Die Doku geht voran, die beiden Apps ziehen nach: FLASH_MARK_LABEL steht in
// src/lib/flash-entitlement.ts und gehoert D-UI, das Web-Gegenstueck W-UI.
// Geprueft wird deshalb, dass docs/ das alte Etikett nirgends mehr in
// Anfuehrungszeichen fuehrt (die Vergleichsseite darf "Included usage" eines
// Wettbewerbers weiter nennen, das ist kein Etikett von uns) und dass das
// Handbuch an beiden Stellen die Entscheidform traegt. Der laufende Wert der
// Apps wird mitgedruckt, damit ein Auseinanderlaufen sichtbar ist, statt
// still zu bleiben; sobald beide Apps nachgezogen sind, wird aus der Zeile
// eine Gleichheitspruefung, eine Zeile.
const FLASH_MARK_DECISION = 'No credits'
const markLabelSource = readFileSync(new URL('../src/lib/flash-entitlement.ts', import.meta.url), 'utf8')
const markLabel = /FLASH_MARK_LABEL = '([^']+)'/.exec(markLabelSource)?.[1]
assert.ok(markLabel, 'FLASH_MARK_LABEL not found in src/lib/flash-entitlement.ts')
const labelOffences = docsFiles(docsRoot).filter((path) => /"Included"|&quot;Included&quot;/.test(readFileSync(path, 'utf8')))
assert.equal(
  labelOffences.length,
  0,
  `the Flash mark is called "${FLASH_MARK_DECISION}" now: ${labelOffences.length} page(s) still quote "Included" [${labelOffences.map((path) => path.slice(docsRoot.length + 1)).join(', ')}]`,
)
assert.ok(
  handbookText.includes(`The picker marks them with "${FLASH_MARK_DECISION}".`),
  `docs/guide/cloud/index.html: the picker mark is not named as "${FLASH_MARK_DECISION}"`,
)
assert.ok(
  handbookText.includes(`<li>"${FLASH_MARK_DECISION}", with the tooltip`),
  `docs/guide/cloud/index.html: the mark list does not lead with "${FLASH_MARK_DECISION}"`,
)
console.log(`Flash-mark guard passed: the handbook calls the mark "${FLASH_MARK_DECISION}" twice and 0 pages in docs/ quote "Included" (the desktop app still ships "${markLabel}", D-UI and W-UI pull it).`)

// ── Das Datum der Messung, einmal ───────────────────────────────────
//
// Beide Verkaufsseiten zitieren den Messlauf im Fliesstext und tragen oben ein
// <time>. Die Messtabelle datiert sich selbst, und das ist die Quelle fuer
// beide Angaben. Eine Seite, die den 9. stempelt und im Text den 10. zitiert,
// laesst den Leser raten, welcher Lauf gemeint ist.
const factsDate = /Produced by the owner on (\d{4}-\d{2}-\d{2})/.exec(readWeb('apps/web/lib/chat/model-facts.md'))?.[1]
assert.ok(factsDate, 'model-facts.md carries no production date')
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const [factsYear, factsMonth, factsDay] = factsDate.split('-')
const factsSpelled = `${monthNames[Number(factsMonth) - 1]} ${Number(factsDay)}, ${factsYear}`
for (const [name, doc] of zahlenseiten) {
  const stamp = doc.querySelector('.post-meta time')
  assert.ok(stamp, `${name}: the post date is gone`)
  assert.equal(stamp.getAttribute('datetime'), factsDate, `${name}: the stamped date is not the date of the measurement it cites`)
  assert.equal(stamp.textContent, factsSpelled, `${name}: the spelled date does not match the stamp`)
  assert.ok(new RegExp(`measured on ${factsDate}`, 'i').test(doc.body.textContent), `${name}: the cited measurement date drifted`)
}
console.log(`Measurement-date guard passed: both sales pages stamp and cite ${factsDate}, the date model-facts.md carries.`)

// ── Die Elf verlinkt nicht auf die Seite, die Fuenf sagt ────────────
//
// publicMediaModels auf lu-labs.ai filtert ueber keptOffThisDomain, dort
// stehen fuenf Videomodelle. Auf locallyuncensored.com gilt die volle Zahl.
// Beide duerfen nebeneinander stehen, nur nicht als Verlinkung: ein Satz, der
// eine Videomodellzahl nennt und im selben Atemzug auf die Preisseite der
// anderen Domain zeigt, schickt den Leser zu einer anderen Zahl.
const linkedCountClaims = []
for (const path of docsFiles(`${docsRoot}/blog`)) {
  for (const satz of readFileSync(path, 'utf8').split(/(?<=\.)\s+/)) {
    if (/\d+ video models?/i.test(satz) && /lu-labs\.ai\/pricing/.test(satz)) {
      linkedCountClaims.push(path.slice(docsRoot.length + 1))
    }
  }
}
assert.equal(
  linkedCountClaims.length,
  0,
  `lu-labs.ai publishes a smaller video count, so no blog sentence may link a count to its pricing page: ${linkedCountClaims.length} sentence(s) [${linkedCountClaims.join(', ')}]`,
)
console.log('Blog guard passed: 0 video-model counts linked to the lu-labs.ai pricing page, where keptOffThisDomain publishes a smaller set.')

// ── Eine Stelle haelt die Version, alle anderen werden geprueft ─────
//
// package.json ist die Wahrheit. Die Seiten sind statisch, also darf die Zahl
// dort stehen, aber keine Seite darf sie aus dem Gedaechtnis tragen. Geprueft
// werden genau die Stellen, die eine AUSSAGE ueber die laufende Version sind;
// historische Versionen in den Blogzeilen und in der Aenderungsliste bleiben
// unangetastet.
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const versionClaims = [
  /"softwareVersion":"([^"]+)"/g,
  /&middot; (\d+\.\d+\.\d+)</g,
  /New in (\d+\.\d+\.\d+)/g,
  /full (\d+\.\d+\.\d+) changelog/g,
  /Current [Vv]ersion: v?(\d+\.\d+\.\d+)/g,
  /^- Version: v?(\d+\.\d+\.\d+)/gm,
]
const versionDrift = []
for (const datei of ['index.html', 'llms.txt', 'llms-full.txt']) {
  const text = readFileSync(new URL(`../docs/${datei}`, import.meta.url), 'utf8')
  for (const muster of versionClaims) {
    for (const treffer of text.matchAll(muster)) {
      if (treffer[1] !== appVersion) versionDrift.push(`${datei}: ${treffer[0].trim()}`)
    }
  }
}
assert.equal(
  versionDrift.length,
  0,
  `package.json says ${appVersion}, so every current-version claim says it: ${versionDrift.length} stale claim(s) [${versionDrift.join(', ')}]`,
)
// Genau eine Angabe je Datei, damit sich nicht zwei Stellen widersprechen
// koennen, wie llms-full.txt es zehn Zeilen auseinander tat.
for (const datei of ['llms.txt', 'llms-full.txt']) {
  const text = readFileSync(new URL(`../docs/${datei}`, import.meta.url), 'utf8')
  const angaben = [...text.matchAll(/Current [Vv]ersion: v?\d+\.\d+\.\d+/g), ...text.matchAll(/^- Version: v?\d+\.\d+\.\d+/gm)]
  assert.equal(angaben.length, 1, `docs/${datei}: ${angaben.length} current-version statements, expected exactly one`)
}
console.log(`Version guard passed: every current-version claim on the home page and in the language-model files says ${appVersion}, the version package.json carries.`)

// ── Der Changelog-Abschnitt der laufenden Version ────────────────────
//
// CHANGELOG.md wird auf GitHub gespiegelt und endete bis zum 12.09.2026 bei
// 2.6.9, obwohl alle fuenf Manifeste auf 3.0.0 stehen. Der Abschnitt haengt
// jetzt an denselben Quellen wie die Verkaufsseiten, damit er nicht die
// zweite, freie Fassung derselben Zahlen wird.
//
// Geprueft wird ohne Zeilenumbrueche, weil der Changelog auf 80 Zeichen
// umgebrochen ist und ein Satz deshalb ueber drei Zeilen laeuft. Ein
// getippter Zeilenumbruch darf einen Wortlaut nicht durchrutschen lassen.
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const changelogSection = changelog.split(/^## \[/m).find((part) => part.startsWith(`${appVersion}]`))
assert.ok(changelogSection, `CHANGELOG.md carries no section for ${appVersion}, the version package.json says`)
const flat = changelogSection.replace(/\s+/g, ' ')
// Der Satz zur Freimenge, Entscheid V3, zeichengleich.
const FLASH_SENTENCE =
  `${flashInCatalog} of the ${catalogSize} models in the catalogue cost no credits at all in chat on an active paid plan, up to ${daily.toLocaleString('en-US')} input and output tokens per day. API keys keep paying credits, and accounts without an active plan keep paying credits too.`
assert.ok(flat.includes(FLASH_SENTENCE), `CHANGELOG.md ${appVersion}: the Flash sentence does not read as the decision writes it`)
// Der Satz zur Marke, Entscheid R6-5, derselbe wie in docs/.
assert.ok(flat.includes(MARK_SENTENCE), `CHANGELOG.md ${appVersion}: the mark sentence does not read as the decision writes it`)
// Keine veraltete Schwelle, keine alte Bedingung, kein altes Etikett.
for (const [pattern, why] of [
  [/\b27 of the\b/, 'the old mark threshold'],
  [/never paid/i, 'the old Flash condition'],
  [/"Included"/, 'the old Flash mark label'],
  [/welcome credits/i, 'the welcome credits, which are switched off'],
]) {
  assert.ok(!pattern.test(flat), `CHANGELOG.md ${appVersion}: ${why} is still in the section`)
}
// Keine Gedankenstriche in dem Abschnitt. Der Altbestand der aelteren
// Abschnitte bleibt unberuehrt, Entscheid David zu R6-21.
const changelogDashes = changelogSection.match(/[–—]|&[mn]dash;/g) ?? []
assert.equal(changelogDashes.length, 0, `CHANGELOG.md ${appVersion}: ${changelogDashes.length} typographic dash(es) in the new section`)
// Nirgends, wie viele Tokens Geld kauft. Dieselbe Regel wie auf den Seiten.
const tokensForMoney = /(EUR|USD|euro|credits?)[^.]{0,60}\b(buys?|gets?|worth)\b[^.]{0,40}tokens/i
assert.ok(!tokensForMoney.test(flat), `CHANGELOG.md ${appVersion}: a sentence says how many tokens money buys`)
console.log(`Changelog guard passed: the ${appVersion} section carries the mark sentence and the Flash sentence word for word, with 0 typographic dashes and 0 token-per-money claims.`)

// ── Die Zahlen des Verkaufs-Panels am Wolkenschalter ─────────────────
//
// David, 13.09.2026: der Schalter zeigt ohne Sitzung ein Verkaufs-Panel mit
// drei gezaehlten Zeilen und einem Preis. Die Zahlen stehen in
// `src/lib/cloud-pitch.ts`, weil sie gebraucht werden, BEVOR jemand angemeldet
// ist. Hier werden sie gegen den Katalog im Web-Repo gezaehlt.
//
// Gezaehlt wird, was ERZEUGT: `adult: true` mit der passenden Gattung und ohne
// `ops`. Ein Eintrag mit `ops` ist ein Werkzeug auf einem vorhandenen Ergebnis
// (`wan-2.2-spicy-extend` verlaengert einen Clip) und kein Modell, das jemand
// im Waehler auswaehlt. Ohne diesen Ausschluss waere die Videozahl um eins zu
// gross.
const mediaSrc = readWeb('apps/web/lib/render/cloud-models.ts')
function openModels(kind) {
  let found = 0
  for (const match of mediaSrc.matchAll(/\{[^{}]*\}/g)) {
    const row = match[0]
    if (!/\bid:\s*'/.test(row)) continue
    if (!new RegExp(`kind:\\s*'${kind}'`).test(row)) continue
    if (!/adult:\s*true/.test(row)) continue
    if (/\bops:\s*\[/.test(row)) continue
    found++
  }
  return found
}

const pitchSrc = readFileSync(new URL('../src/lib/cloud-pitch.ts', import.meta.url), 'utf8')
function pitchNumber(field) {
  const match = new RegExp(`\\b${field}:\\s*([\\d_]+),`).exec(pitchSrc)
  assert.ok(match, `CLOUD_PITCH.${field} carries no number`)
  return Number(match[1].replaceAll('_', ''))
}

const openImage = openModels('image')
const openVideo = openModels('video')
assert.equal(pitchNumber('openImageModels'), openImage,
  `open image models: the panel says ${pitchNumber('openImageModels')}, the catalogue holds ${openImage}`)
assert.equal(pitchNumber('openVideoModels'), openVideo,
  `open video models: the panel says ${pitchNumber('openVideoModels')}, the catalogue holds ${openVideo}`)

// Der Preis auf dem Kaufknopf und das Guthaben dahinter.
const hostedTier = tiers.find((row) => row.id === 'hosted')
assert.ok(hostedTier, 'pricing.ts carries no hosted tier')
assert.equal(pitchNumber('hostedMonthlyEUR'), hostedTier.monthlyEUR, 'the buy button quotes a stale price')
assert.equal(pitchNumber('hostedCredits'), tierCredits.hosted, 'the entry plan credit budget drifted')

// Der Abo-Satz, aus den lebenden Tabellen des Web-Repos geteilt, genau wie
// dort in `apps/web/lib/billing/subscriber-rate.ts`. Gegen das BESTE Paket,
// damit der Satz untertreibt statt zu schmeicheln.
//
// Der Desktop fuehrt KEINE Packgroessen: sie werden im Web-Repo gesetzt und
// haetten hier nur eine zweite, immer aeltere Fassung. Er fuehrt allein den
// fertigen Faktor, und der wird hier nachgeteilt.
const webPacks = objects(source('apps/web/lib/billing/topup.ts'))
  .filter(verkaeuflich)
  .map((row) => ({ credits: row.credits, eurCents: row.eurCents }))
const bestPackRate = Math.max(...webPacks.map((p) => p.credits / (p.eurCents / 100)))
const hostedRate = tierCredits.hosted / hostedTier.monthlyEUR
const factor = Math.round((hostedRate / bestPackRate) * 10) / 10
assert.ok(factor >= 1.4 && factor <= 1.6,
  `the subscriber advantage is ${factor}x, outside the 1.4 to 1.6 the sentence claims`)
// Und die Zahl, die der Desktop von Hand fuehrt, ist genau diese.
const desktopFactorMatch = /SUBSCRIBER_CREDIT_FACTOR = ([\d.]+)/.exec(pitchSrc)
assert.ok(desktopFactorMatch, 'SUBSCRIBER_CREDIT_FACTOR carries no number')
assert.equal(Number(desktopFactorMatch[1]), factor,
  `the desktop carries ${desktopFactorMatch[1]}x, the live web tables divide out to ${factor}x`)
const SUBSCRIBER_LINE =
  `Subscribers get about ${factor.toFixed(1)}x more credits per euro and ${daily.toLocaleString('en-US')} free Flash tokens a day.`
assert.ok(flat.includes(SUBSCRIBER_LINE),
  `CHANGELOG.md ${appVersion}: the subscriber sentence does not read as the live tables compute it`)

// Und die drei Zeilen des Panels, im Changelog mit `open` statt `uncensored`.
for (const [claim, why] of [
  [`${MARKED_MODELS} chat models with no refusals`, 'the mark count'],
  [`${openVideo} open video models`, 'the open video count'],
  [`${openImage} open image models`, 'the open image count'],
]) {
  assert.ok(flat.includes(claim), `CHANGELOG.md ${appVersion}: ${why} does not match the catalogue (${claim})`)
}
console.log(`Cloud panel guard passed: ${MARKED_MODELS} marked chat models, ${openVideo} open video and ${openImage} open image models counted in the catalogue, EUR ${hostedTier.monthlyEUR} on the button, and a subscriber advantage of ${factor}x divided out of the live pack and plan tables.`)

// ── R5-57, R5-58, R5-59: the Desktop seed must not silently fall behind ─────
//
// The desktop app's own offline fallback catalog (src/lib/render/
// cloud-models.ts, CLOUD_MODEL_SEED) is a separate, hand-copied file, not a
// generated mirror of the web catalog: it exists so Create still has a model
// list before the first live GET /api/jobs/catalog lands. qwen-image-edit
// (an 'ops: ['edit']' model, maskless) went missing from it entirely and was
// unreachable from the edit picker until this fix, exactly the class of drift
// this guard exists to catch on the next model the two catalogs disagree on.
//
// Deliberately an ID + LABEL comparison, nothing about price: the seed is
// meant to go stale on price (the live catalog is the pricing truth, see the
// module comment at the top of cloud-models.ts) and a guard that failed on
// that would be noise nobody could act on. `wan-2.2-spicy-extend` is read
// here as an ordinary row like any other, unrenamed, so a guard that lived
// only to protect ITS id would be pointless duplication of the type system.
const desktopMediaPath = new URL('../src/lib/render/cloud-models.ts', import.meta.url)
const desktopMediaSource = ts.createSourceFile(
  'cloud-models.ts', readFileSync(desktopMediaPath, 'utf8'), ts.ScriptTarget.Latest, true,
)
// Own small AST walk rather than the shared `objects()` above: that helper
// only captures string/numeric literals, so it cannot see `edit: true`
// (a boolean) or `ops: ['edit']` (an array) at all. Reading each object
// literal's own full text (not a single source LINE) is what makes this safe
// against entries that spread id/label/edit/ops across several lines,
// which is how flux-dev is written in both files.
function editCapableIds(sourceFile) {
  const out = new Map()
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const text = node.getText(sourceFile)
      const id = /id:\s*'([^']+)'/.exec(text)?.[1]
      if (id) {
        const label = /label:\s*'([^']+)'/.exec(text)?.[1]
        const editCapable = /edit:\s*true/.test(text) || /ops:\s*\[[^\]]*'edit'[^\]]*\]/.test(text)
        if (editCapable) out.set(id, label)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return out
}
const desktopEditModels = editCapableIds(desktopMediaSource)
const webEditModels = editCapableIds(mediaSource)
assert.ok(desktopEditModels.size > 0, 'no edit-capable model found in the desktop seed at all')
for (const [id, webLabel] of webEditModels) {
  assert.ok(desktopEditModels.has(id),
    `desktop seed is missing the edit-capable model '${id}' (${webLabel}) that the web catalogue serves`)
  assert.equal(desktopEditModels.get(id), webLabel,
    `desktop seed labels '${id}' as "${desktopEditModels.get(id)}", web calls it "${webLabel}"`)
}
console.log(`Seed sync guard passed: ${desktopEditModels.size} edit-capable model(s) in the desktop seed match the web catalogue by id and label.`)
