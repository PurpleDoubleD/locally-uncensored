/**
 * GH #224 (C51): Chat Tools in the plain chat only reached a model when an
 * English or German pattern matched. A user writing Japanese got no tool on
 * any turn. A message the detector cannot read now carries the tools, and the
 * model decides; English and German stay as they were.
 *
 * Run: npx vitest run src/lib/__tests__/chat-tools-every-language.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectorReads, resolveChatToolRoute } from '../chat-tool-intent'

const OTHER_LANGUAGES = [
  '猫の画像を作ってください', // Japanese: make a picture of a cat
  '最新的Python版本是什么？', // Chinese: what is the latest Python version
  'найди в интернете погоду в Берлине', // Russian: find the weather in Berlin online
  'ابحث عن أخبار اليوم', // Arabic: search today's news
  'dibuja un gato en la luna', // Spanish
  'dessine un chat sur la lune', // French
  'cerca su internet il meteo di Roma', // Italian
  'wygeneruj obraz kota w kosmosie', // Polish
]

describe('GH #224: a message the detector cannot read carries the tools', () => {
  for (const text of OTHER_LANGUAGES) {
    it(`"${text}" goes to the tools, the model decides`, () => {
      expect(detectorReads(text)).toBe(false)
      expect(resolveChatToolRoute(text, false, [])).toEqual({ capability: 'open' })
    })
  }

  it('an open route carries no media hint: the model picks the tool, nothing is forced', () => {
    expect(resolveChatToolRoute('猫の画像を作って', false, [])?.mediaHint).toBeUndefined()
  })
})

describe('English and German stay as before', () => {
  for (const text of [
    'how are you today?',
    'explain recursion to me',
    'what is the capital of France',
    'wie geht es dir?',
    'erklär mir bitte die Photosynthese',
    'hallo',
    'hola',
    'ok',
    'thanks!',
    '42',
    '🙂👍',
    '',
  ]) {
    it(`"${text}" stays on the plain path`, () => {
      expect(detectorReads(text)).toBe(true)
      expect(resolveChatToolRoute(text, false, [])).toBeNull()
    })
  }

  it('a recognised English or German request still routes by its own capability', () => {
    expect(resolveChatToolRoute('draw me a picture of a red apple', false, [])?.capability).toBe('image')
    expect(resolveChatToolRoute('such im netz nach dem wetter', false, [])?.capability).toBe('web')
  })

  it('a mostly English message with a foreign name in it is still read', () => {
    expect(detectorReads('what does 東京 mean in English')).toBe(true)
  })
})
