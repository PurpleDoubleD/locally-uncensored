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
function objects(file, root = file) {
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
        // Eine Liste aus Zeichenketten, etwa flashTiers: in welchen Plaenen
        // ein Flash-Modell ohne Credits laeuft.
        if (ts.isArrayLiteralExpression(value) && value.elements.length > 0 && value.elements.every((el) => ts.isStringLiteral(el))) {
          row[key] = value.elements.map((el) => el.text)
        }
      }
      out.push(row)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
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
// Seit 3.0.8 (Kimi K3.1 Pro) spreizt CLOUD_CATALOG die Eintraege auf festem
// Weg aus direct-catalog.ts hinein. Ohne sie zaehlte der Waechter ein Modell
// zu wenig. Aeltere Web-Staende haben den Spread nicht und bleiben wie sie sind.
if (readWeb('apps/web/lib/chat/tier-models.ts').includes('...FIXED_UPSTREAM_CATALOG')) {
  const direct = source('apps/web/lib/chat/direct-catalog.ts')
  let fixed
  ts.forEachChild(direct, function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(direct) === 'FIXED_UPSTREAM_CATALOG') fixed = node.initializer
    else ts.forEachChild(node, find)
  })
  assert.ok(fixed, 'direct-catalog.ts: FIXED_UPSTREAM_CATALOG missing')
  catalog.push(...objects(direct, fixed))
}
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
// TIER_CREDITS beim Namen suchen: credits.ts traegt seit Oktober 2026 eine
// zweite Tabelle mit denselben Plan-Schluesseln (TIER_TRAININGS), und die
// Credits selbst stehen in tier-credits.ts. Die erste Tabelle mit "hosted"
// waere die falsche.
function namedObject(file, name) {
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      found = objects(ts.createSourceFile('x.ts', `const x = ${node.initializer.getText(file)}`, ts.ScriptTarget.Latest, true))[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
const tierCredits = ['apps/web/lib/billing/tier-credits.ts', 'apps/web/lib/billing/credits.ts']
  .filter((path) => existsSync(resolve(webRoot, path)))
  .map((path) => namedObject(source(path), 'TIER_CREDITS'))
  .find(Boolean)
assert.ok(tierCredits, 'TIER_CREDITS not found in tier-credits.ts or credits.ts')

// Seit dem Umbau der Seite auf Karten traegt die Karte selbst alle drei
// Anker, und die Zahlen stehen in eigenen Elementen: der Preis als "€19" in
// .luc-plan-price, das Jahr in .luc-plan-annual, das Guthaben in
// .luc-plan-wallet. Geprueft wird der Anker gegen die Quelle UND der
// sichtbare Text gegen den Anker, sonst kann die Karte etwas anderes zeigen,
// als ihr Attribut sagt.
const sichtbar = (card, selector, what) => {
  const el = card.querySelector(selector)
  assert.ok(el, `${card.dataset.planId ?? card.dataset.packId}: ${what} is not on the card (${selector})`)
  return el.textContent
}
for (const card of pricing.querySelectorAll('[data-plan-id]')) {
  const tier = tiers.find((row) => row.id === card.dataset.planId)
  assert.ok(tier, `Plan missing from pricing.ts: ${card.dataset.planId}`)
  assert.equal(Number(card.dataset.monthlyEur), tier.monthlyEUR, `${tier.id}: monthly price drift`)
  assert.equal(sichtbar(card, '.luc-plan-price strong', 'the monthly price'), `€${tier.monthlyEUR}`, `${tier.id}: monthly price text drift`)
  assert.equal(Number(card.dataset.annualEur), tier.annualEUR, `${tier.id}: annual price drift`)
  assert.equal(sichtbar(card, '.luc-plan-annual', 'the annual price'), `€${tier.annualEUR}/year · billed annually`, `${tier.id}: annual price text drift`)
  assert.equal(Number(card.dataset.planCredits), tierCredits[card.dataset.planId], `${tier.id}: credit drift`)
  assert.equal(
    sichtbar(card, '.luc-plan-wallet strong', 'the monthly credits'),
    `${tierCredits[card.dataset.planId].toLocaleString('en-US')} credits/month`,
    `${tier.id}: credit text drift`,
  )
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
for (const card of pricing.querySelectorAll('[data-pack-id]')) {
  const entry = packs.find((row) => row.id === card.dataset.packId)
  assert.ok(entry, `Pack missing from topup.ts: ${card.dataset.packId}`)
  assert.equal(Number(card.dataset.eurCents), entry.eurCents, `${entry.id}: pack price drift`)
  assert.equal(Number(card.dataset.credits), entry.credits, `${entry.id}: pack credit drift`)
  assert.equal(sichtbar(card, '.price', 'the pack price'), `€${entry.eurCents / 100}`, `${entry.id}: pack price text drift`)
  assert.equal(sichtbar(card, 'strong', 'the pack credits'), `${entry.credits.toLocaleString('en-US')} credits`, `${entry.id}: pack credit text drift`)
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
const flashRows = catalog.filter((row) => row.usageClass === 'flash')
const flashInCatalog = flashRows.length
// Nicht jedes Flash-Modell laeuft in jedem Plan ohne Credits: der Katalog
// fuehrt je Modell `flashTiers`. Die Seite nennt die Zahl deshalb je Plan,
// und jeder Anker haengt an der Zahl SEINES Plans. Ein Anker ohne Plan meint
// alle Flash-Modelle des Katalogs.
const flashForTier = (tier) => flashRows.filter((row) => Array.isArray(row.flashTiers) && row.flashTiers.includes(tier)).length
const flashCounts = pricing.querySelectorAll('[data-flash-model-count]')
assert.ok(flashCounts.length > 0, 'docs/pricing/index.html: the Flash model count carries no anchor')
for (const flashCount of flashCounts) {
  const tier = flashCount.dataset.flashTier
  if (tier !== undefined) assert.ok(tiers.some((row) => row.id === tier), `flash model count names an unknown plan: ${tier}`)
  const expected = tier === undefined ? flashInCatalog : flashForTier(tier)
  assert.equal(Number(flashCount.dataset.flashModelCount), expected, `flash model count drift${tier ? ` (${tier})` : ''}`)
  assert.equal(flashCount.textContent, String(expected), `flash model count text drift${tier ? ` (${tier})` : ''}`)
}
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
// Entscheid des Inhabers R6-5 vom 12.09.2026: die Marke traegt nur, was in BEIDEN
// Laeufen nach der strengen Regel `full` war. Das sind 24, hergeleitet in
// e2e/6-nachlauf/marken-nachmessung.md, Abschnitt 13.2 und Zeile "Sicher
// `full` nach strenger Regel in beiden Laeufen | 24". Die Zahl steht hier
// ausgeschrieben, weil sie ein Entscheid ist und keine Ableitung; abgeleitet
// wird, was sie darf.
// Entscheid vom 05.10.2026: fuenf der 24 haben im Drei-Runden-Test in
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
  `${MARKED_MODELS} of the ${measuredSize} cloud chat models we measured answer in full without refusing, and only those carry the No Filter mark.`
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
// Zwei Stellen: die Cloud-Seite und die Preisseite. Die dritte war die
// Kopfbeschreibung der Cloud-Seite; die traegt seit dem Umbau vom 22.09.2026
// (7db6aee6) keine Zahl mehr.
assert.ok(markSentences >= 2, `the mark sentence stands in ${markSentences} place(s) in docs/, expected at least 2`)
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
assert.equal(pitch.chatModels, catalogSize, 'pitch: chat model count drift')
assert.equal(pitch.measuredChatModels, measuredSize, 'pitch: measured set drift')
assert.equal(pitch.unfilteredChatModels, unfilteredFull, 'pitch: unfiltered count drift')
assert.equal(pitch.flashModels, catalog.filter((row) => row.usageClass === 'flash').length, 'pitch: flash count drift')
assert.equal(pitch.flashDailyTokens, daily, 'pitch: daily ceiling drift')
// Seit 24.10.2026 (Davids Entscheid) zaehlen Bild- und Videozahl des Panels
// die Generatoren des Create-Studios mit, wie die offenen Zahlen. Die Menge
// steht als Gruppe "Image generation" bzw. "Video generation" in der
// Komplettliste der Preisseite. Hier wird gegen den Katalog gegengeprueft:
// jede Id dort steht im Web-Katalog und ist nicht ausgemustert, jede
// klassische Erzeugerzeile und jedes offene Studio-Modell der Gattung steht
// dort, und das Panel nennt genau ihre Anzahl.
const retiredPath = 'apps/web/lib/render/retired-models.ts'
const retiredIds = new Set(existsSync(resolve(webRoot, retiredPath))
  ? [...readWeb(retiredPath).matchAll(/^\s+'([^']+)': \{ since:/gm)].map((m) => m[1])
  : [])
const studioAll = existsSync(resolve(webRoot, 'apps/web/lib/render/studio-models.json'))
  ? JSON.parse(readWeb('apps/web/lib/render/studio-models.json'))
  : {}
const generatorGroup = (title) => {
  const group = [...pricing.querySelectorAll('details.luc-model-group')]
    .find((el) => el.querySelector('summary')?.firstChild?.textContent.trim() === title)
  assert.ok(group, `docs/pricing/index.html: the group ${title} is gone`)
  const ids = [...group.querySelectorAll('[data-all-model-id]')].map((li) => li.dataset.allModelId)
  assert.equal(Number(group.querySelector('summary span')?.textContent), ids.length, `docs/pricing/index.html: ${title} counts its list wrong`)
  return ids
}
for (const [kind, title, field] of [['image', 'Image generation', 'imageModels'], ['video', 'Video generation', 'videoModels']]) {
  const ids = generatorGroup(title)
  for (const id of ids) {
    const row = mediaRows.find((r) => r.id === id) ?? studioAll[id]
    assert.ok(row, `docs/pricing/index.html: ${id} in ${title} is not in the web catalogue`)
    assert.equal(row.kind, kind, `docs/pricing/index.html: ${id} in ${title} is no ${kind} model`)
    assert.ok(!retiredIds.has(id), `docs/pricing/index.html: ${id} in ${title} is retired`)
    assert.ok(!opsIds.has(id) && studioAll[id]?.sourceModel === undefined, `docs/pricing/index.html: ${id} in ${title} is a tool or a twin`)
  }
  const classicGenerators = mediaRows.filter((r) => r.kind === kind && !opsIds.has(r.id) && !retiredIds.has(r.id)).map((r) => r.id)
  const openStudio = Object.entries(studioAll).filter(([id, r]) => r.adult === true && r.kind === kind && r.sourceModel === undefined && !/-extend$/.test(id) && !retiredIds.has(id)).map(([id]) => id)
  for (const id of [...classicGenerators, ...openStudio]) {
    assert.ok(ids.includes(id), `docs/pricing/index.html: the generator ${id} is missing from ${title}`)
  }
  assert.equal(pitch[field], ids.length, `pitch: ${kind} model count drift`)
}
// Absichtliche Abweichung: der Desktop nennt die volle Katalogliste, die
// Kaufseite auf lu-labs.ai nennt weniger. publicMediaModels filtert dort ueber
// keptOffThisDomain (the web app), weil
// die erwachsenenfaehigen Videoendpunkte auf der Zahlungsdomain nicht beworben
// werden. Hier wird deshalb gegen die UNGEFILTERTE Liste geprueft, und das ist
// kein Versehen. Ob der Desktop weiter die volle Zahl nennen soll, waehrend
// die Kaufseite eine kleinere nennt, ist Entscheid des Inhabers.
// Die Videozahl haengt seit 24.10.2026 an der Gruppe "Video generation", siehe oben.
console.log(`Cloud switch guard passed: ${pitch.unfilteredChatModels}/${pitch.chatModels} chat, ${pitch.flashModels} flash, ${pitch.imageModels} image and ${pitch.videoModels} video match the web catalogue.`)

console.log(`Pricing guard passed: ${tiers.filter((t) => typeof t.monthlyEUR === 'number').length} plans, ${packs.length} packs, ${unfilteredFull}/${catalogSize} models and the ${daily.toLocaleString('en-US')} token ceiling match the web source.`)

// ── Die sechs Erwachsenen-Videomodelle auf der LUC-Preisseite ────────
//
// Entscheid des Inhabers (R3-8, 12.09.2026): die sechs Endpunkte ohne eingebaute
// Inhaltsbeschraenkung stehen mit Namen und Credit-Preis je Clip auf der
// LUC-Preisseite. lu-labs.ai bleibt unberuehrt; dort haelt keptOffThisDomain
// sie weiter von der Zahlungsdomain fern, und genau deshalb darf diese Seite
// nicht von der Kaufseite abgeschrieben werden. Namen und Preise kommen aus
// dem Katalog: cloud-models.ts liefert Id und Etikett, credits.ts den
// Dollarsatz und den Credit-Kurs. Eine Tokenmenge je Geld steht nirgends.
// Seit dem Web-Stand 3.0.6 ist ein Name mit Markenwort im Web-Repo einmal
// geschrieben, als Vorlage um einen Platzhalter: `Wan 2.2 ${STATEMENT_MARK_LABEL}`,
// seit Oktober 2026 `Wan 2.2 ${STATEMENT_NAME_WORD}`.
// Die Zahlungsdomain fuellt ihn mit ihrem neutralen Wort, die Desktop-App und
// diese Seiten mit dem Wort aus lib/render/desktop-names.ts (der Server gibt
// es der App als native_label). Gelesen wird der Katalog hier deshalb in der
// Schreibweise der App; ein aelterer Web-Stand ohne die Datei hat feste Namen
// und bleibt, wie er ist.
const desktopNamesPath = 'apps/web/lib/render/desktop-names.ts'
const desktopWord = existsSync(resolve(webRoot, desktopNamesPath))
  ? /export const DESKTOP_MARK_LABEL = '([^']+)'/.exec(readWeb(desktopNamesPath))?.[1]
  : undefined
const inDesktopNames = (text) => text.replace(/`([^`$]*)\$\{(?:STATEMENT_MARK_LABEL|STATEMENT_NAME_WORD)\}([^`$]*)`/g, (whole, before, after) => {
  assert.ok(desktopWord, `${desktopNamesPath}: the catalogue names a model through the placeholder, but the desktop word is not readable`)
  return `'${before}${desktopWord}${after}'`
})
const mediaText = inDesktopNames(mediaSource.getFullText())
const classicAdultVideo = mediaText.split('\n')
  .filter((line) => /kind: 'video'/.test(line) && /adult: true/.test(line) && !/ops: \[/.test(line))
  .map((line) => ({ id: /id: '([^']+)'/.exec(line)?.[1], label: /label: '([^']+)'/.exec(line)?.[1] }))
assert.ok(classicAdultVideo.length > 0 && classicAdultVideo.every((row) => row.id && row.label), 'adult video rows unreadable')
// Die Zaehlregel, Entscheid vom 22.09.2026 (src/lib/cloud-pitch.ts fuehrt
// sie aus): gezaehlt wird jeder Eintrag mit `adult: true`, den ein Kunde
// selbst waehlt, auch der aus dem Create-Studio. Der Studio-Katalog liegt in
// studio-models.json. Heraus fallen dort die Zwillinge mit `sourceModel`
// (derselbe Endpunkt unter zweitem Namen, schon klassisch gezaehlt) und die
// Werkzeuge, die einen vorhandenen Clip verlaengern.
const studioPath = 'apps/web/lib/render/studio-models.json'
const studioCatalogue = existsSync(resolve(webRoot, studioPath)) ? JSON.parse(readWeb(studioPath)) : {}
// Seit Oktober 2026 hat das Wort im Namen eine eigene Konstante
// (STATEMENT_NAME_WORD), getrennt vom Wort der Marke; aeltere Web-Staende
// kennen nur STATEMENT_MARK_LABEL.
const markText = readWeb('apps/web/lib/unfiltered-mark.ts')
const webWord = (/export const STATEMENT_NAME_WORD = '([^']+)'/.exec(markText) ?? /export const STATEMENT_MARK_LABEL = '([^']+)'/.exec(markText))?.[1]
const studioLabel = (label) => (webWord && desktopWord ? label.replace(new RegExp(`\\b${webWord}\\b`, 'g'), desktopWord) : label)
const studioOpen = (kind) => Object.entries(studioCatalogue)
  .filter(([id, row]) => row.adult === true && row.kind === kind && row.sourceModel === undefined && !/-extend$/.test(id))
  .map(([id, row]) => ({ id, label: studioLabel(row.label), studio: row }))
const adultVideo = [...classicAdultVideo, ...studioOpen('video')]
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
const adultRows = [...pricing.querySelectorAll('[data-open-video-row]')]
assert.equal(
  adultRows.length,
  adultVideo.length,
  `docs/pricing/index.html: the page lists ${adultRows.length} adult video models, the catalogue has ${adultVideo.length}`,
)
// Entscheid vom 08.10.2026: die Anzeigenamen dieser Endpunkte heissen
// "Uncensored". Er loest den Entscheid vom 13.09.2026 ab. Verglichen wird die
// volle Beschriftung; das Markenwort wird zusaetzlich gegen den Entscheid
// geprueft, nicht nur gegen das Web. Auf der Zahlungsdomain taucht keiner
// dieser Endpunkte auf (Entscheid dbf663fe).
const MARKENWORT = 'Uncensored'
// Zwei Studio-Modelle heissen ohne das Markenwort und sind trotzdem offen:
// die Marke haengt am Katalogfeld, nie am Namen. Die Ausnahme ist namentlich,
// wie in src/lib/__tests__/offene-modelle-in-den-texten.test.ts. Die beiden
// MiniMax H3 Singularity tragen das Wort seit Web 1738bc86 (24.10.2026).
const OFFEN_OHNE_MARKENWORT = new Set(['open-video', 'open-video-lora'])
// Die Seite ordnet nach Preis, der Katalog nach Herkunft. Verglichen wird
// deshalb je Id: dieselbe Menge, jede Zeile mit Namen und Preis ihrer Id, und
// die Preise auf der Seite steigen nie.
const adultById = new Map(adultVideo.map((model) => [model.id, model]))
const pageIds = adultRows.map((row) => row.querySelector('[data-open-model-id]')?.dataset.openModelId)
assert.deepEqual([...pageIds].sort(), [...adultById.keys()].sort(),
  'docs/pricing/index.html: the adult video rows are not the open video models of the catalogue')
let lastCredits = 0
adultRows.forEach((row, index) => {
  const name = row.querySelector('[data-open-model-id]')
  assert.ok(name, `docs/pricing/index.html: adult video row ${index + 1} carries no model anchor`)
  const model = adultById.get(name.dataset.openModelId)
  assert.equal(name.textContent, model.label,
    `docs/pricing/index.html: adult video label drift for ${model.id}`)
  assert.equal(name.textContent.includes(MARKENWORT), !OFFEN_OHNE_MARKENWORT.has(model.id),
    `docs/pricing/index.html: ${model.id} and the decided word ${MARKENWORT} do not go together as decided`)
  assert.ok(!/\bOpen\b/.test(name.textContent),
    `docs/pricing/index.html: ${model.id} still carries the withdrawn word Open`)
  const cell = row.querySelector('[data-clip-credits]')
  assert.ok(cell, `docs/pricing/index.html: no clip price anchor for ${model.id}`)
  let credits
  if (model.studio) {
    // Ein Studio-Modell rechnet je Sekunde Ausgabe und je Aufloesung
    // (studio-contract.ts, studioCredits). Die Seite nennt den Clip von fuenf
    // Sekunden in der kleinsten Aufloesung, die das Modell anbietet.
    assert.equal(model.studio.price?.mode, 'output', `${model.id}: the studio price is no longer per second of output`)
    const perSecond = Math.min(...Object.values(model.studio.price.rates))
    credits = Math.ceil((perSecond * 5) / creditUsd - 1e-9)
  } else {
    const price = clipPrice(model.id)
    credits = Math.ceil(price.base / creditUsd)
    // Der Satz daneben sagt "five seconds, no eight second option". Er haengt
    // daran, dass die klassischen in der Preistabelle keinen 8-Sekunden-Satz
    // haben; clipLengths blendet den Knopf genau daran aus (R3-8).
    assert.equal(price.long, undefined, `docs/pricing/index.html: ${model.id} now has an 8s rate, the five-second sentence is stale`)
  }
  assert.equal(Number(cell.dataset.clipCredits), credits, `docs/pricing/index.html: clip price drift for ${model.id}`)
  assert.equal(cell.textContent, credits.toLocaleString('en-US'), `docs/pricing/index.html: clip price text drift for ${model.id}`)
  assert.ok(credits >= lastCredits, `docs/pricing/index.html: ${model.id} stands out of price order`)
  lastCredits = credits
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
// Gemessen am Release-Artefakt, nicht geschaetzt: am 09.10.2026 hat
// Locally.Uncensored_3.0.5_x64-setup.exe am GitHub-Release 18.763.351 Bytes
// (zu 3.0.0 waren es 14.075.397). Im Repo haelt das Handbuch diese Zahl, und
// jede Seite, die eine Installergroesse nennt, nennt dieselbe. Mit jedem
// Release am neuen Artefakt nachmessen und zuerst das Handbuch aendern.
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
// Seit 3.0.6 gibt es einen Mac-Bau: Apple Silicon, macOS 14 oder neuer, kein
// Intel. Der Anker ist die Antwort im Handbuch. Jede andere Seite darf dem
// nicht widersprechen und nicht mehr versprechen, als dort steht.
const macAnswer = readFileSync(new URL('../docs/guide/faq-and-glossary/index.html', import.meta.url), 'utf8')
assert.ok(
  macAnswer.includes('The Mac build is for Apple Silicon and needs macOS 14 or newer. Intel Macs are not supported. The .dmg is signed and notarized.'),
  'docs/guide/faq-and-glossary/index.html: the Mac answer drifted',
)
// Was eine Seite ueber den Mac nicht sagen darf. Ein Release-Beitrag darf
// von seinem eigenen Release sagen, dass es keinen Mac-Bau hatte ("This
// release has no macOS build", "3.0.1 was built for Windows and Linux only").
const macDenials = /\bno (native )?(Mac|macOS)( desktop)? build\b|never (been|was) one|macOS is not supported|\b(is|are) Windows and Linux only\b|Locally Uncensored currently does not/i
const macOverclaims = /roadmap[^.]*\bmac(os)?\b|\bmac(os)?\b[^.]*roadmap|notari[sz]ed|Intel Macs? (is|are) supported|universal (binary|build)/i
const macWrong = []
for (const path of docsFiles(docsRoot)) {
  const text = readFileSync(path, 'utf8')
  for (const satz of text.split(/(?<=[.!?])["\s]|\n/)) {
    if (/This release has no macOS build/.test(satz)) continue
    // The one sentence about signing: true for the .dmg of a release run
    // (Developer ID, notarized, Gatekeeper accepts it), and only in these words.
    if (satz.trim() === 'The .dmg is signed and notarized.') continue
    // The security page says the same about the app: signed with the
    // Developer ID and notarized by Apple (checked on the 3.0.8 .dmg with
    // spctl and stapler on 4 November 2026). That claim is allowed; anything
    // else the sentence says is still checked.
    const rest = satz.replace(/\bsigned (with an Apple Developer ID )?and notari[sz]ed by Apple\b/gi, 'signed')
    if (macDenials.test(rest) || macOverclaims.test(rest)) macWrong.push(`${path.slice(docsRoot.length + 1)}: ${satz.trim().slice(0, 70)}`)
  }
}
assert.equal(
  macWrong.length,
  0,
  `There is a Mac build for Apple Silicon since 3.0.6, and nothing beyond that is proven: ${macWrong.length} sentence(s) deny it or promise more [${macWrong.join(' | ')}]`,
)
// Wer ein .dmg anbietet, sagt auf derselben Seite, fuer welche Macs.
const dmgWithoutChip = docsFiles(docsRoot)
  .filter((path) => /\.dmg\b/i.test(readFileSync(path, 'utf8')) && !/Apple Silicon/.test(readFileSync(path, 'utf8')))
  .map((path) => path.slice(docsRoot.length + 1))
assert.equal(dmgWithoutChip.length, 0, `A page that offers a .dmg names Apple Silicon: ${dmgWithoutChip.join(', ')}`)
// Die Fernzugriff-Anleitung fuehrt bis ins Fenster der App. Auf einem Mac
// ist dieser Weg nicht nachgeprueft, deshalb traegt sie dort keine
// Installationszeile.
const remoteAccess = readFileSync(new URL('../docs/remote-access/index.html', import.meta.url), 'utf8')
const macSetupLines = remoteAccess.split('\n').filter((zeile) => /macos/i.test(zeile))
assert.equal(macSetupLines.length, 0, `Remote access is not checked on a Mac, so docs/remote-access/index.html carries no macOS setup line: ${macSetupLines.length}`)
for (const platform of ['Windows:', 'Linux:']) {
  assert.ok(remoteAccess.includes(platform), `docs/remote-access/index.html: the ${platform} line is gone`)
}
console.log('Mac guard passed: the handbook says Apple Silicon and macOS 14 or newer, 0 sentences in docs/ deny the Mac build or promise more than that, every page with a .dmg names Apple Silicon, and the remote-access guide carries 0 macOS setup lines.')

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
// "and reported" ist eine Zusage ueber eine Meldung. Solange der Meldeweg des
// Servers wahlfrei ist, darf keine Seite in docs/ eine Meldung versprechen.
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
// Entscheid vom 12.09.2026 zum Zusatzfund V3: ein einmaliger Pack von
// 5 Euro oeffnet die Freimenge NICHT auf Dauer. Die Bedingung heisst kuenftig
// "laufendes bezahltes Abo", nicht "hat je einmal gezahlt".
//
// Seit dem Merge vom 12.09.2026 traegt der Code die Regel selbst:
// `planPays` (the web app) nimmt nur noch den Rang der aktiven
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
  // "on an active paid plan" oder "needs an active paid plan": beide binden
  // die Freimenge an den laufenden Plan, die Preisseite schreibt das zweite.
  assert.ok(/(?:on|needs) an active paid plan/.test(raw), `${name}: the Flash allowance is not tied to an active plan`)
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
// Entscheid vom 12.09.2026 zum Wortlaut, den der Verfasser der
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
const factsText = readWeb('apps/web/lib/chat/model-facts.md')
const factsDate = /Produced by the owner on (\d{4}-\d{2}-\d{2})/.exec(factsText)?.[1]
assert.ok(factsDate, 'model-facts.md carries no production date')
// Seit dem 05.10.2026 gibt es einen zweiten Lauf: die Messtabelle fuehrt die
// Herabstufungen jenes Tages. Die Seiten zitieren beide Laeufe, und der
// Stempel oben traegt den JUENGSTEN, den die Tabelle nennt: von dem Tag ist
// die Zahl, die auf der Seite steht.
const laterRuns = [...factsText.matchAll(/(?:downgraded|re-measured|measured again)[^.]*? on (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1])
const stampDate = [factsDate, ...laterRuns].sort().at(-1)
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const [stampYear, stampMonth, stampDay] = stampDate.split('-')
const stampSpelled = `${monthNames[Number(stampMonth) - 1]} ${Number(stampDay)}, ${stampYear}`
for (const [name, doc] of zahlenseiten) {
  const stamp = doc.querySelector('.post-meta time')
  assert.ok(stamp, `${name}: the post date is gone`)
  assert.equal(stamp.getAttribute('datetime'), stampDate, `${name}: the stamped date is not the date of the newest measurement it cites`)
  assert.equal(stamp.textContent, stampSpelled, `${name}: the spelled date does not match the stamp`)
  for (const run of new Set([factsDate, stampDate])) {
    assert.ok(new RegExp(`measured on ${factsDate}`, 'i').test(doc.body.textContent) && doc.body.textContent.includes(run),
      `${name}: the cited measurement date ${run} drifted`)
  }
}
console.log(`Measurement-date guard passed: both sales pages cite ${factsDate} and stamp ${stampDate}, the dates model-facts.md carries.`)

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
  /\bv(\d+\.\d+\.\d+) &middot;/g,
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
// Ein Link auf releases/latest/download/<Datei> traegt die Version im
// Dateinamen. Er zeigt nur dann auf eine Datei, wenn der Name zur laufenden
// Version gehoert, also wird jeder solche Link im ganzen Baum geprueft, auch
// der im Handbuch und jeder, der spaeter dazukommt.
const staleDownloads = []
const downloadLink = /releases\/latest\/download\/([^"'\s<>)]+)/g
for (const path of docsFiles(docsRoot)) {
  for (const treffer of readFileSync(path, 'utf8').matchAll(downloadLink)) {
    if (!treffer[1].includes(appVersion)) staleDownloads.push(`${path.slice(docsRoot.length + 1)}: ${treffer[1]}`)
  }
}
assert.equal(
  staleDownloads.length,
  0,
  `package.json says ${appVersion}, so every direct download link names a file of that version: ${staleDownloads.length} stale link(s) [${staleDownloads.join(', ')}]`,
)
// Die Startseite bietet Windows, Mac und Linux gleichwertig an: zwei
// Download-Bloecke und der Knopf in der Navigation, je System ein Knopf mit
// der passenden Datei, dazu die Wahl darunter. Welcher Satz sichtbar ist,
// entscheidet html[data-os] (Inline-Skript, assets/home.css).
const homeText = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8')
const downloadFile = { win: /_x64-setup\.exe$/, mac: /_aarch64\.dmg$/, linux: /_amd64\.AppImage$/ }
const downloadDrift = []
for (const [was, anzahl] of [['class="dl-btn" data-dl-for', 2], ['class="lu-nav-dl" data-dl-for', 1], ['data-dl-os', 2]]) {
  for (const [os, datei] of Object.entries(downloadFile)) {
    const links = [...homeText.matchAll(new RegExp(`<a ${was}="${os}" href="([^"]+)"`, 'g'))].map((m) => m[1])
    if (links.length !== anzahl) downloadDrift.push(`${was}="${os}": ${links.length} instead of ${anzahl}`)
    for (const link of links) if (!datei.test(link)) downloadDrift.push(`${was}="${os}": ${link}`)
  }
}
for (const paket of ['_amd64.deb', '.x86_64.rpm']) {
  if (homeText.split(`${paket}" download>`).length - 1 !== 2) downloadDrift.push(`${paket} is not linked from both download blocks`)
}
assert.equal(downloadDrift.length, 0, `docs/index.html offers every system its own file: ${downloadDrift.length} difference(s) [${downloadDrift.join(', ')}]`)
// Der Abschnitt "What's new" der Startseite nennt seit dem 09.10.2026 keine
// Version mehr: er verweist auf releases/latest, den Changelog und den Blog.
// Davor stand dort "New in 3.0.1" und blieb seit 3.0.2 stehen. Kommt wieder
// ein Abschnitt "New in X" (lu-306-texte/website-changes.md, braucht
// Ueberschrift und Bilder), gilt weiter: Ueberschrift, Sprungmarke und
// Changelog-Verweis nennen dieselbe Version, die ist nicht neuer als die
// laufende, und ein Rueckstand wird bei jedem Lauf laut genannt.
const whatsNew = new Set([
  ...[...homeText.matchAll(/New in (\d+\.\d+\.\d+)/g)].map((m) => m[1]),
  ...[...homeText.matchAll(/full (\d+\.\d+\.\d+) changelog/g)].map((m) => m[1]),
])
assert.ok(whatsNew.size <= 1, `docs/index.html: the "New in" section names ${whatsNew.size} versions [${[...whatsNew].join(', ')}]`)
const versionKey = (v) => v.split('.').map((n) => n.padStart(4, '0')).join('.')
for (const v of whatsNew) {
  assert.ok(versionKey(v) <= versionKey(appVersion), `docs/index.html: the "New in" section names ${v}, newer than package.json (${appVersion})`)
  if (v !== appVersion) console.log(`OPEN, owner decision: the home page section "New in ${v}" is behind package.json (${appVersion}).`)
}
// Genau eine Angabe je Datei, damit sich nicht zwei Stellen widersprechen
// koennen, wie llms-full.txt es zehn Zeilen auseinander tat.
for (const datei of ['llms.txt', 'llms-full.txt']) {
  const text = readFileSync(new URL(`../docs/${datei}`, import.meta.url), 'utf8')
  const angaben = [...text.matchAll(/Current [Vv]ersion: v?\d+\.\d+\.\d+/g), ...text.matchAll(/^- Version: v?\d+\.\d+\.\d+/gm)]
  assert.equal(angaben.length, 1, `docs/${datei}: ${angaben.length} current-version statements, expected exactly one`)
}
console.log(`Version guard passed: every current-version claim on the home page and in the language-model files says ${appVersion}, the version package.json carries, every direct download link in docs/ names a file of that version, and the home page offers Windows, Mac and Linux each its own file in both download blocks and in the navigation.`)

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
// Die Saetze zur Freimenge, zur Marke und zum Abo-Vorteil standen als Pflicht
// im Abschnitt zu 3.0.0, mit dem das Verkaufs-Panel kam. Kein Abschnitt danach
// hat sie wiederholt, und ein veroeffentlichter Abschnitt wird nicht
// nachtraeglich umgeschrieben. Die Regel heisst deshalb seit dem 09.10.2026:
// der Abschnitt der laufenden Version muss diese Saetze nicht tragen, aber WO
// er eine solche Aussage macht, stimmt sie mit der Quelle.
//
// Die Freimenge: jede Nennung im Abschnitt haengt am laufenden Plan.
for (const satz of flat.split(/(?<=\.)\s+/)) {
  if (/cost no credits at all in chat|free Flash tokens/i.test(satz) && !/Subscribers get/.test(satz)) {
    assert.ok(/on an active paid plan/.test(satz) && satz.includes(daily.toLocaleString('en-US')),
      `CHANGELOG.md ${appVersion}: a Flash sentence does not carry the active plan and the daily ceiling [${satz.slice(0, 90)}]`)
  }
}
// Die Marke: ein Verhaeltnis im Abschnitt traegt die Zahlen der Messtabelle.
// Das Wort der Marke ist das des Tages, an dem der Abschnitt erschien: bis
// 3.0.5 "No refusals", seit dem Entscheid vom 08.10.2026 "No Filter".
const MARK_WORDS = ['No Filter', 'No refusals']
for (const hit of flat.match(markRatio) ?? []) {
  assert.ok(MARK_WORDS.some((word) => hit === MARK_SENTENCE.replace('No Filter', word)),
    `CHANGELOG.md ${appVersion}: the mark sentence does not carry the measured numbers [${hit}]`)
}
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
// Abschnitte bleibt unberuehrt, Entscheid zu R6-21.
const changelogDashes = changelogSection.match(/[–—]|&[mn]dash;/g) ?? []
assert.equal(changelogDashes.length, 0, `CHANGELOG.md ${appVersion}: ${changelogDashes.length} typographic dash(es) in the new section`)
// Nirgends, wie viele Tokens Geld kauft. Dieselbe Regel wie auf den Seiten.
const tokensForMoney = /(EUR|USD|euro|credits?)[^.]{0,60}\b(buys?|gets?|worth)\b[^.]{0,40}tokens/i
assert.ok(!tokensForMoney.test(flat), `CHANGELOG.md ${appVersion}: a sentence says how many tokens money buys`)
console.log(`Changelog guard passed: what the ${appVersion} section says about the mark and the Flash allowance matches the source, with 0 typographic dashes and 0 token-per-money claims.`)

// ── Die Zahlen des Verkaufs-Panels am Wolkenschalter ─────────────────
//
// 13.09.2026: der Schalter zeigt ohne Sitzung ein Verkaufs-Panel mit
// drei gezaehlten Zeilen und einem Preis. Die Zahlen stehen in
// `src/lib/cloud-pitch.ts`, weil sie gebraucht werden, BEVOR jemand angemeldet
// ist. Hier werden sie gegen den Katalog im Web-Repo gezaehlt.
//
// Gezaehlt wird, was ERZEUGT und was jemand selbst waehlt: klassisch
// `adult: true` mit der passenden Gattung und ohne `ops` (ein Eintrag mit
// `ops` ist dort ein Werkzeug auf einem vorhandenen Ergebnis, etwa
// `wan-2.2-spicy-extend`), dazu die Studio-Modelle aus `studioOpen`.
const mediaSrc = inDesktopNames(readWeb('apps/web/lib/render/cloud-models.ts'))
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
  // Dazu die Studio-Modelle, nach derselben Regel wie auf der Preisseite
  // (Entscheid 22.09.2026, hergeleitet in src/lib/cloud-pitch.ts).
  return found + studioOpen(kind).length
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
// dort in the web app. Gegen das BESTE Paket,
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
// Der Abschnitt der laufenden Version: nennt er den Abo-Vorteil oder zaehlt er
// offene Modelle, dann mit diesen Zahlen (als Ziffer oder als Zahlwort).
for (const hit of flat.match(/Subscribers get about [\d.]+x more credits per euro/g) ?? []) {
  assert.equal(hit, `Subscribers get about ${factor.toFixed(1)}x more credits per euro`,
    `CHANGELOG.md ${appVersion}: the subscriber sentence does not read as the live tables compute it`)
}
const ZAHLWORT = { three: 3, six: 6, seven: 7, nine: 9, ten: 10, fourteen: 14, fifteen: 15, seventeen: 17 }
const zahl = (text) => (/^\d+$/.test(text) ? Number(text) : ZAHLWORT[text.toLowerCase()])
for (const [kind, expected] of [['video', openVideo], ['image', openImage]]) {
  const claims = [
    ...flat.matchAll(new RegExp(`\\b(\\d+|${Object.keys(ZAHLWORT).join('|')}) (?:open |uncensored )?${kind} models\\b[^.]*\\bcloud catalogue`, 'gi')),
    ...flat.matchAll(new RegExp(`\\b(\\d+) (?:open|uncensored) ${kind} models\\b`, 'gi')),
  ]
  for (const claim of claims) {
    assert.equal(zahl(claim[1]), expected, `CHANGELOG.md ${appVersion}: the open ${kind} count does not match the catalogue (${expected})`)
  }
}
for (const hit of flat.match(/\b\d+ (?:No Filter|No refusals) chat models\b/g) ?? []) {
  assert.equal(Number(/\d+/.exec(hit)[0]), MARKED_MODELS, `CHANGELOG.md ${appVersion}: the mark count does not match the catalogue (${MARKED_MODELS})`)
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
