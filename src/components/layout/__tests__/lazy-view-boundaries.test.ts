/**
 * M7 / Audit W-T2 — die Lazy-Grenzen der Top-Level-Views.
 *
 * Der Boot-Chunk lag bei 1968 kB, das Audit-Soll bei < 800 kB. Der größte
 * Hebel war, alles hinter eine `React.lazy`-Grenze zu legen, was beim Start
 * niemand sieht. Diese Datei pinnt die vier Eigenschaften, ohne die genau
 * dieser Umbau zum Rückschritt wird:
 *
 *   1. Der beim Start sichtbare View bleibt statisch — sonst tauscht man
 *      Bundle-Größe gegen einen weißen Blitz beim Kaltstart.
 *   2. Die übrigen Views sind wirklich draußen (kein statischer Import, der
 *      das `import()` still wieder wirkungslos macht — Muster M7).
 *   3. Jede Suspense-Grenze hat einen Fallback mit Geometrie, kein `null` und
 *      kein nacktes „Loading…".
 *   4. Ein gescheiterter Chunk-Import landet in einer ErrorBoundary, nicht im
 *      weißen Bildschirm.
 *
 * Plus die Anti-Selbstbetrugs-Klausel des Audits: die Chunk-Warnung darf nicht
 * weggeschraubt werden.
 *
 * Run: npx vitest run src/components/layout/__tests__/lazy-view-boundaries.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

const appShell = read('../AppShell.tsx')
const lazyView = read('../LazyView.tsx')
const skeletons = read('../ViewSkeletons.tsx')
const markdown = read('../../chat/MarkdownRenderer.tsx')
const viteConfig = read('../../../../vite.config.ts')

/** Die fünf Views, die niemand sieht, bevor er sie anklickt. */
const LAZY_VIEWS = [
  ['ModelManager', '../models/ModelManager'],
  ['BenchmarkView', '../models/BenchmarkView'],
  ['SettingsPage', '../settings/SettingsPage'],
  ['CreateExperimental', '../create/experimental/CreateExperimental'],
  ['Onboarding', '../onboarding/Onboarding'],
] as const

describe('der Boot-View bleibt statisch', () => {
  it('ChatView wird direkt importiert, nicht lazy', () => {
    expect(appShell).toContain("import { ChatView } from '../chat/ChatView'")
    expect(appShell).not.toMatch(/import\(\s*'\.\.\/chat\/ChatView'/)
  })

  it('und rendert ohne Suspense-Umweg', () => {
    expect(appShell).toContain("{currentView === 'chat' && <ErrorBoundary><ChatView /></ErrorBoundary>}")
  })

  it('uiStore startet weiterhin auf chat — sonst stimmt die Annahme oben nicht', () => {
    const uiStore = read('../../../stores/uiStore.ts')
    expect(uiStore).toContain("currentView: 'chat',")
    // currentView wird nicht persistiert, jeder Kaltstart landet also auf chat.
    expect(uiStore).not.toMatch(/partialize:[\s\S]{0,200}currentView/)
  })
})

describe('die übrigen fünf Views sind wirklich draußen', () => {
  it.each(LAZY_VIEWS)('%s wird dynamisch geladen', (_name, path) => {
    expect(appShell).toContain(`import('${path}')`)
  })

  it.each(LAZY_VIEWS)('%s hat KEINEN statischen Import mehr (M7)', (_name, path) => {
    // Genau das Muster, das das Audit anprangert: ein import(), das durch einen
    // statischen Import derselben Datei wirkungslos wird.
    expect(appShell).not.toMatch(new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*'${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  })

  it('jeder Loader steht auf Modulebene, damit LazyView nicht bei jedem Repaint neu mountet', () => {
    for (const [, path] of LAZY_VIEWS) {
      expect(appShell).toMatch(new RegExp(`^const load\\w+ = \\(\\) => import\\('${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`, 'm'))
    }
  })
})

describe('jede Grenze hat einen Fallback mit Geometrie', () => {
  it('jede LazyView-Verwendung reicht ein Skelett durch', () => {
    const uses = [...appShell.matchAll(/<LazyView\s+load=\{(\w+)\}\s+fallback=\{<(\w+)\s*\/>\}/g)]
    expect(uses.length).toBe(LAZY_VIEWS.length)
    for (const [, , fallback] of uses) {
      expect(fallback).toMatch(/Skeleton$/)
    }
  })

  it('kein Fallback ist null oder ein blanker Text', () => {
    expect(appShell).not.toMatch(/fallback=\{null\}/)
    expect(appShell).not.toMatch(/fallback=\{?["']/)
    expect(skeletons).not.toMatch(/>\s*Loading[.…]*\s*</)
  })

  it('die Skelette tragen die Container-Klassen ihrer Views, nicht nur einen Spinner', () => {
    // h-full: sonst kollabiert <main> auf 0 px und der ganze Rahmen springt.
    expect(skeletons).toContain('h-full flex overflow-hidden')   // ModelManager
    expect(skeletons).toContain('max-w-lg mx-auto px-4 py-4')    // SettingsPage
    expect(skeletons).toContain('max-w-2xl mx-auto px-4 py-4')   // BenchmarkView
    expect(skeletons).toContain('relative h-full w-full flex flex-col') // Create
    expect(skeletons).toContain('h-screen w-screen flex items-center justify-center') // Onboarding
  })

  it('und melden sich bei Screenreadern', () => {
    expect(skeletons).toContain('role="status"')
    expect(skeletons).toContain('aria-busy="true"')
  })

  it('für jeden lazy View existiert genau ein Skelett-Export', () => {
    for (const name of ['ModelManager', 'Benchmark', 'Settings', 'Create', 'Onboarding']) {
      expect(skeletons).toContain(`export function ${name}Skeleton()`)
    }
  })
})

describe('ein kaputter Chunk kippt die App nicht in Weiß', () => {
  it('die Suspense-Grenze liegt INNERHALB der ErrorBoundary', () => {
    // Andersherum gefangen wäre der Reject nicht: die Boundary muss über der
    // Stelle stehen, an der lazy() wirft.
    expect(lazyView).toMatch(/<ErrorBoundary[^>]*>\s*<Suspense/)
  })

  it('der Retry der Boundary erzeugt eine frische lazy-Payload', () => {
    // React.lazy merkt sich auch die Ablehnung — ohne Neuerzeugung wäre der
    // Retry-Knopf Dekoration.
    expect(lazyView).toContain('onRetry={retry}')
    expect(lazyView).toContain('setView(() => lazy(withOneRetry(load)))')
  })

  it('die ErrorBoundary ruft onRetry auch wirklich auf', () => {
    expect(read('../../ui/ErrorBoundary.tsx')).toContain('this.props.onRetry?.()')
  })
})

describe('KaTeX hängt nicht mehr am Boot', () => {
  it('MarkdownRenderer importiert rehype-katex nur dynamisch', () => {
    expect(markdown).not.toMatch(/^import rehypeKatex from 'rehype-katex'/m)
    expect(markdown).toContain("import('rehype-katex')")
  })

  it('das Stylesheet bleibt statisch — nachgeladenes CSS hieße unformatierte Formeln', () => {
    expect(markdown).toContain("import 'katex/dist/katex.min.css'")
  })

  it('das Gatter kommt aus dem getesteten Leaf-Modul, nicht aus einer Inline-Heuristik', () => {
    expect(markdown).toContain('contentNeedsKatex')
  })
})

describe('ANTI-SELBSTBETRUG: die Warnschwelle bleibt, wo sie ist', () => {
  it('chunkSizeWarningLimit wird nicht hochgeschraubt', () => {
    expect(viteConfig).not.toContain('chunkSizeWarningLimit')
  })
})
