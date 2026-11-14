/**
 * B5 (2026-08-04): the example-video stage is gone and the path to the
 * cloud is one click shorter.
 *
 * The reason this file exists rather than trusting the diff: the in-app login
 * used to hang off a SINGLE step. "Already got an account? Sign in" appeared
 * only on the plans step, so any change to where "Get LU Cloud" leads could
 * silently take the login away from every existing subscriber, and nothing
 * would have failed. The sign-in entry now sits on both signed-out steps, and
 * these tests are what keeps it there.
 *
 * There is no render harness in this repo (no @testing-library), so this guards
 * the source, the same way DownloadBadge-autoclose.test.ts does. The click path
 * itself is covered by e2e/cloud-create.spec.ts.
 *
 * Run: npx vitest run src/components/cloud/__tests__/cloud-path-shortened.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cloudGateHeadline } from '../../../lib/mac-pc-words'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

const gate = read('src/components/cloud/CloudGateModal.tsx')
const teaser = read('src/components/cloud/CloudTeaserModal.tsx')

describe('the example-video stage is gone', () => {
  it('the component, its assets and its build scripts no longer exist', () => {
    expect(existsSync(resolve(ROOT, 'src/components/cloud/CloudExampleModal.tsx'))).toBe(false)
    // 3.4 MB of webm shipped in every bundle on all three platforms.
    expect(existsSync(resolve(ROOT, 'public/teasers'))).toBe(false)
    expect(existsSync(resolve(ROOT, 'scripts/teasers'))).toBe(false)
  })

  it('nothing references it any more', () => {
    for (const f of [
      'src/components/layout/AppShell.tsx',
      'src/stores/uiStore.ts',
      'src/components/cloud/CloudTeaserModal.tsx',
      'package.json',
    ]) {
      const src = read(f)
      expect(src, `${f} still mentions the example modal`).not.toMatch(/CloudExampleModal|cloudExampleVideo/)
      expect(src, `${f} still mentions the teaser assets`).not.toMatch(/teasers\//)
    }
  })

  it('the teaser sheet goes straight into checkout from both surfaces', () => {
    // The intent branch used to call setCloudExampleVideo, then both branches
    // went to the in-app gate. Since 2026-09-07 the one button opens
    // /checkout/start in the browser with the card size as src, and the gate
    // is no longer referenced from the sheet. Since 3.1.0 with two equal
    // buttons, the subscription and the pack (funnel Nr. 4), both through
    // lib/cloud-links, which adds the place the click came from.
    expect(teaser).toMatch(/openExternal\(checkoutStartUrl\(\{ order, src, medium: 'create-sheet' \}\)\)/)
    expect(teaser).toMatch(/<BuyChoice/)
    expect(teaser).toMatch(/gpuGb !== null \? `gpu\$\{gpuGb\}` : 'gpu-unknown'/)
    expect(teaser).not.toMatch(/setCloudGateOpen/)
    expect(teaser).not.toMatch(/setCloudExampleVideo/)
    // The branch itself is gone, not just its call.
    expect(teaser).not.toMatch(/if \(t\.surface === 'intent'\)/)
  })
})

/**
 * Dieselbe Absicht, neue Form (13.09.2026).
 *
 * Der abgemeldete Weg hatte drei Schritte (Hero, Plaene, Anmeldung) und der
 * Waechter verlangte den Anmeldeeinstieg auf ZWEI davon, weil er auf dem
 * mittleren allein zu leicht verschwand. Seit dem Verkaufs-Panel gibt es nur
 * noch zwei Schritte: das Panel und die Anmeldung. Der Zwischenschritt ist
 * geloescht, also kann der Einstieg auch nur noch einmal vorkommen.
 *
 * Was der Waechter schuetzt, bleibt damit unveraendert: wer schon zahlt, muss
 * von der ersten Flaeche aus in die Anmeldung kommen, ohne vorher auf etwas zu
 * klicken, das nach Kaufen aussieht. Nur die Stelle, an der das geprueft wird,
 * ist mitgewandert. Die Zahl 2 durch 1 zu ersetzen und sonst nichts waere die
 * faule Variante gewesen: sie haette auch dann noch gegriffen, wenn der
 * Einstieg in den Kaufknopf gerutscht waere.
 */
describe('the in-app login survives wherever the sales panel leads', () => {
  it('the sign-in entry sits on the sales panel, exactly once', () => {
    const entries = gate.match(/Already bought\? Sign in/g) ?? []
    expect(entries.length, 'sign-in entry must be on the sales panel').toBe(1)
    // Der alte Wortlaut darf nicht danebenstehen bleiben.
    expect(gate).not.toMatch(/Already got an account|Already subscribed\? Sign in/)
  })

  it('it reaches the login step', () => {
    expect(gate).toMatch(/setStep\('login'\)/)
    expect(gate).toMatch(/step === 'login'/)
  })

  it('the entry is inside the sales panel, not somewhere else in the file', () => {
    // Aus dem Panel herausgeschnitten, damit die Zusicherung nicht an einer
    // Kopie irgendwo sonst im Tor vorbeigeht.
    // Ende am Kommentar der naechsten Funktion, nicht an deren Kopf: der
    // Kommentar von `CloudHero` traegt einen Gedankenstrich aus der Zeit, als
    // die noch erlaubt waren, und der faellt sonst dem Panel zur Last.
    const start = gate.indexOf('function CloudSalesPanel(')
    const end = gate.indexOf('/** The LU monogram')
    expect(start, 'sales panel not found').toBeGreaterThan(-1)
    expect(end, 'the monogram comment no longer follows the panel').toBeGreaterThan(start)
    const panel = gate.slice(start, end)
    expect(panel).toMatch(/Already bought\? Sign in/)
    expect(panel).toMatch(/onSignIn/)
    // Funnel 3.1.0 (Nr. 11): at the top, before the headline, not under the
    // buy buttons where somebody back from the browser found the offer first.
    expect(panel.indexOf('Already bought? Sign in')).toBeLessThan(panel.indexOf('cloudGateHeadline('))
    expect(panel.indexOf('Already bought? Sign in')).toBeLessThan(panel.indexOf('<BuyChoice'))
  })

  it('the login step still has a way back, and it points at the panel', () => {
    // Hiess "Back to plans" und zeigte auf den geloeschten Zwischenschritt.
    expect(gate).toMatch(/setStep\('sales'\)/)
    expect(gate, 'the deleted step is still referenced').not.toMatch(/Back to plans/)
    expect(gate, "the deleted step's branch is back").not.toMatch(/step === 'plans'/)
  })
})

/**
 * Das Verkaufs-Panel selbst: was es sagen MUSS, und was es nicht sagen darf.
 *
 * Quelltext-Waechter wie die uebrigen in dieser Datei; den Klickweg misst
 * `e2e/cloud-sales-panel.spec.ts` im laufenden Programm.
 */
describe('the sales panel argues before it asks for a login', () => {
  const panel = gate.slice(gate.indexOf('function CloudSalesPanel('), gate.indexOf('/** The LU monogram'))
  /** JSX bricht einen Satz ueber mehrere Zeilen um; der Leser sieht trotzdem
   *  einen Satz. Geprueft wird deshalb gegen den geglaetteten Quelltext, sonst
   *  misst der Waechter die Einrueckung statt den Wortlaut. */
  const flach = panel.replace(/\s+/g, ' ')

  it('carries the kicker, the headline, the subtitle and the footnote', () => {
    expect(flach).toContain('Cloud')
    // The headline has a Mac wording, so it lives in lib/mac-pc-words.
    expect(flach).toContain('{cloudGateHeadline(isMacOS())}')
    expect(cloudGateHeadline(false)).toBe('Run uncensored models in the cloud, no GPU needed.')
    expect(flach).toContain('Turn on Cloud to reach the full catalogue from any machine.')
    expect(flach).toContain('Your local models keep working exactly as they do now.')
    expect(flach).toContain('Local mode stays free and offline.')
  })

  it('takes the three lines and the price from the constants, never typed', () => {
    expect(panel).toContain('cloudSalesLines()')
    // The price sits on the subscription card of BuyChoice since 3.1.0.
    expect(panel).toContain('<BuyChoice')
    expect(read('src/components/cloud/BuyChoice.tsx')).toContain('CLOUD_PITCH.hostedMonthlyEUR')
    expect(panel).toContain('CLOUD_SUBSCRIBER_LINE')
    // Negativkontrolle: keine getippte Zahl im Kaufknopf. Genau so ist der
    // Nenner des Blatts einmal veraltet stehen geblieben.
    expect(panel, 'the price is typed into the button').not.toMatch(/for 19 EUR/)
    expect(panel, 'a model count is typed into the panel').not.toMatch(/\b(24|10|6|3) (chat|uncensored)/)
  })

  it('sends the purchase to the browser, never into the app', () => {
    // Both buttons go to the checkout start on lu-labs.ai, "See all plans"
    // to the pricing page, each through lib/cloud-links.
    expect(panel).toMatch(/openGateCheckout\(order, 'app-gate-main', 'gate', from\)/)
    expect(panel).toMatch(/openExternal\(cloudLink\('\/pricing', 'gate', from\)\)/)
    const links = read('src/lib/cloud-links.ts')
    expect(links).toMatch(/cloudLink\(`\/checkout\/start\?/)
    // Die App hat nie eine Zahlung angefasst.
    expect(panel).not.toMatch(/stripe/i)
    expect(links).not.toMatch(/stripe\.com|checkout\.stripe/i)
  })

  it('is plain: no gradient, no glow, no emoji', () => {
    expect(panel).not.toMatch(/bg-gradient|shadow-\[|animate-|drop-shadow/)
    expect(panel, 'emoji in a UI string').not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    expect(panel).not.toMatch(/[–—]/u)
  })
})
