// remark-math options for chat rendering. singleDollarTextMath OFF means a lone
// `$` is treated as currency, not a math delimiter, so "$30. Each pays $10"
// renders as written instead of being swallowed into KaTeX and glued together
// (David 2026-08-08, seen in the thinking stream). Block math ($$…$$) still
// renders, which is what an actual formula uses in this app.
export const MATH_OPTIONS = { singleDollarTextMath: false } as const

// M7 / Audit W-T2 — KaTeX ist 455 kB und damit der mit Abstand größte einzelne
// Posten im Boot-Chunk gewesen. Gebraucht wird es nur, wenn eine Nachricht
// wirklich Formeln enthält. Damit das Nachladen kein Ratespiel wird, ist dieses
// Prädikat eine bewiesene *Obermenge* der Fälle, in denen rehype-katex am Baum
// überhaupt etwas ändert. rehype-katex greift an genau drei Klassen an:
//
//   • `math-display` / `math-inline` — setzt remark-math. Mit
//     MATH_OPTIONS (singleDollarTextMath: false) entstehen sie ausschließlich
//     aus `$$`; ein einzelnes `$` ist Währung und erzeugt keinen Math-Knoten.
//   • `language-math` — entsteht aus einem Code-Zaun mit der Info-Zeichenkette
//     `math` (```math). Der Zaun geht durch rehype-katex, *bevor* die
//     `code`-Komponente von MarkdownRenderer ihn je zu sehen bekommt.
//
// Roher HTML-Code kann die Klassen nicht einschleusen: react-markdown läuft
// ohne rehype-raw, HTML wird escaped. Fehlen also `$$` und der math-Zaun, ist
// rehype-katex beweisbar ein No-op und das Nachladen entfällt ersatzlos.
//
// Die Einrückung ist absichtlich unbeschränkt (`[ \t]*` statt der 0–3 Zeichen
// der CommonMark-Regel): ein tief in einer Liste verschachtelter Zaun bleibt so
// erfasst. Die Regel irrt damit nur in die harmlose Richtung — sie lädt einmal
// zu viel, nie einmal zu wenig.
const MATH_FENCE = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*math(?![\w-])/

export function contentNeedsKatex(content: string): boolean {
  return content.includes('$$') || MATH_FENCE.test(content)
}
