/**
 * CivitAI-Beschreibungen sind Text, nicht Markup.
 *
 * Befund am echten Windows-Bau, 21.09.2026
 * (e2e/box-gruen/t15/shots/C4-search-pixel-results.png): in der Trefferliste
 * der LoRA-Suche stand woertlich
 *
 *   My Classic lora pixel ArtNote : Remove : High quality in promt &amp;
 *   negative low qualityModel recomend : Noobai 0.75Tr
 *
 * Das Feld ist HTML, und abgeschnitten wurden bisher nur die Tags. Die
 * Entitaeten blieben stehen und wurden als Zeichen gezeigt.
 *
 * Run: npx vitest run src/api/__tests__/civitai-beschreibung-ist-text.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { civitaiDescriptionToText } from '../discover'

describe('civitaiDescriptionToText', () => {
  it('loest den gemessenen Befund auf', () => {
    expect(civitaiDescriptionToText('High quality in promt &amp; negative low quality'))
      .toBe('High quality in promt & negative low quality')
  })

  it('dekodiert die fuenf Entitaeten, die das Feld wirklich traegt', () => {
    expect(civitaiDescriptionToText('&quot;a&quot; &#39;b&#39; &lt;c&gt; &amp; d'))
      .toBe('"a" \'b\' <c> & d')
  })

  it('kennt auch die hexadezimale Schreibweise des Apostrophs und das feste Leerzeichen', () => {
    expect(civitaiDescriptionToText('it&#x27;s&nbsp;here')).toBe("it's here")
  })

  it('schneidet die Tags weiterhin ab', () => {
    expect(civitaiDescriptionToText('<p>Hallo <b>Welt</b></p>')).toBe('Hallo Welt')
  })

  it('`&amp;` kommt ZULETZT dran: doppelt kodiertes bleibt sichtbar statt zu einem Tag zu werden', () => {
    // Waere `&amp;` zuerst dekodiert, entstuende aus `&amp;lt;script&amp;gt;`
    // erst `&lt;script&gt;` und daraus `<script>`. Ein Tag, das der Server
    // bewusst doppelt kodiert hat, darf der Client nicht auspacken.
    expect(civitaiDescriptionToText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
  })

  it('GEGENPROBE: gewoehnlicher Text bleibt Zeichen fuer Zeichen derselbe', () => {
    expect(civitaiDescriptionToText('Pixel Art XL, 512x768, weight 0.5')).toBe('Pixel Art XL, 512x768, weight 0.5')
  })

  it('die Trefferliste rendert das Ergebnis als Text, nicht als HTML', () => {
    // Die Bedingung, unter der das Dekodieren ueberhaupt zulaessig ist.
    const panel = readFileSync(
      resolve(__dirname, '..', '..', 'components', 'models', 'CivitaiSearchPanel.tsx'), 'utf8')
    expect(panel).toContain('{model.description}')
    expect(panel).not.toContain('dangerouslySetInnerHTML')
  })

  it('und die Suche schickt ihre Beschreibung wirklich durch diese Funktion', () => {
    const src = readFileSync(resolve(__dirname, '..', 'discover.ts'), 'utf8')
    // C18 (3.1.0): the HTML is read once; the line of the hit and the full
    // text of the Details dialog both go through the text conversion.
    expect(src).toContain("const rawHtml = asString(prop(item, 'description')) ?? ''")
    expect(src).toContain('const rawDesc = civitaiDescriptionToText(rawHtml)')
    expect(src).toContain('fullDescription: rawHtml ? civitaiDescriptionToParagraphs(rawHtml) : undefined')
    const para = src.slice(src.indexOf('export function civitaiDescriptionToParagraphs'), src.indexOf('const CIVITAI_MODEL_FILE'))
    expect(para).toContain('return civitaiDescriptionToText(withBreaks)')
  })
})
