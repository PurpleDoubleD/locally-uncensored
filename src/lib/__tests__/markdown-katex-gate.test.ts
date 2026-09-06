/**
 * M7 / Audit W-T2 — das Nachlade-Gatter für KaTeX.
 *
 * MarkdownRenderer holt rehype-katex (455 kB) erst, wenn der Text es braucht.
 * Die Behauptung dahinter ist keine Heuristik, sondern eine Aussage über den
 * Baum: `contentNeedsKatex(content) === false` ⟹ rehype-katex ändert an diesem
 * Dokument nichts. Genau das prüfen diese Tests — mit der echten Pipeline, in
 * derselben Reihenfolge, mit denselben Plugins und Optionen wie im Renderer.
 *
 * Fällt das um, ist es kein Stilproblem: dann verschluckt die App still eine
 * Formel. Der Vergleich läuft deshalb strukturell über den hast-Baum, nicht
 * über eine Stichprobe von Klassennamen.
 *
 * Run: npx vitest run src/lib/__tests__/markdown-katex-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import { MATH_OPTIONS, contentNeedsKatex } from '../markdown-math'

/** Der hast-Baum, so wie react-markdown ihn rendern würde. */
async function tree(md: string, withKatex: boolean): Promise<string> {
  const pipeline = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, MATH_OPTIONS)
    .use(remarkRehype)
  if (withKatex) pipeline.use(rehypeKatex)
  const out = await pipeline.run(pipeline.parse(md))
  return JSON.stringify(out)
}

/** Ändert rehype-katex an diesem Dokument etwas? */
async function katexChangesAnything(md: string): Promise<boolean> {
  const [without, withIt] = await Promise.all([tree(md, false), tree(md, true)])
  return without !== withIt
}

// Texte OHNE Math — hier muss das Gatter zu bleiben, sonst laden wir 455 kB
// für nichts.
const NO_MATH = [
  'Just a plain sentence.',
  'Split the $30 bill. Each of the 3 pays $10.',
  'inline `code` and a [link](https://example.com)',
  'a lone $x$ stays currency because singleDollarTextMath is off',
  '```js\nconst a = 1\n```',
  '```mathematica\n(* not our fence *)\n```',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  'a backslash formula \\(a^2\\) is not a delimiter here',
]

// Texte MIT Math — beide Wege, über die rehype-katex überhaupt anspringt.
const WITH_MATH = [
  '$$a^2 + b^2 = c^2$$',
  '$$\na^2 + b^2 = c^2\n$$',
  'the identity $$e^{i\\pi}=-1$$ holds',
  '```math\na^2\n```',
  '- item\n  ```math\n  a^2\n  ```',
  '1. step\n   ```math\n   a^2\n   ```',
]

describe('contentNeedsKatex ist eine Obermenge dessen, was rehype-katex anfasst', () => {
  it.each(NO_MATH)('kein Math, also kein Nachladen: %j', async (md) => {
    // Die eigentliche Zusicherung: das Plugin wegzulassen ändert nichts …
    expect(await katexChangesAnything(md)).toBe(false)
    // … und genau deshalb darf das Gatter zu bleiben.
    expect(contentNeedsKatex(md)).toBe(false)
  })

  it.each(WITH_MATH)('Math vorhanden, also Nachladen: %j', async (md) => {
    // Erst beweisen, dass rehype-katex hier wirklich etwas tut …
    expect(await katexChangesAnything(md)).toBe(true)
    // … dann, dass das Gatter aufmacht.
    expect(contentNeedsKatex(md)).toBe(true)
  })
})

describe('NEGATIV-KONTROLLE: das Gatter irrt nur in die harmlose Richtung', () => {
  it('ein $$ im Codeblock lädt einmal zu viel, aber nie zu wenig', () => {
    // Hier ändert rehype-katex nichts, das Gatter macht trotzdem auf. Das ist
    // der beabsichtigte Preis für eine Regel ohne Sonderfälle: ein überflüssiger
    // Ladevorgang ist unsichtbar, eine verschluckte Formel nicht.
    expect(contentNeedsKatex('```\n$$a^2$$\n```')).toBe(true)
  })

  it('ein einzelnes Dollarzeichen macht nicht auf', () => {
    expect(contentNeedsKatex('costs $5')).toBe(false)
  })

  it('das Wort math allein macht nicht auf — nur der Zaun', () => {
    expect(contentNeedsKatex('I like math and mathematics.')).toBe(false)
    expect(contentNeedsKatex('```mathml\n<x/>\n```')).toBe(false)
  })
})
