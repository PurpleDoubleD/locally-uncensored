import { describe, it, expect } from 'vitest'
import { generatedOk, resultUrl } from '../chat-background'

describe('reading the image_generate result for a scene background', () => {
  it('finds the address on the last line', () => {
    const r = 'Image generated: LU_00012_.png (prompt: "harbour at dusk")\nhttp://127.0.0.1:8188/view?filename=LU_00012_.png&type=output'
    expect(resultUrl(r)).toBe('http://127.0.0.1:8188/view?filename=LU_00012_.png&type=output')
    expect(generatedOk(r)).toBe(true)
  })
  it('a Mac render hands a blob address', () => {
    expect(generatedOk('Image generated: mflux.png (prompt: "x")\nblob:http://localhost/abc')).toBe(true)
  })
  it.each([
    'Error: No local image model is installed yet.',
    'Cannot generate: width must be a number from 64 to 4096 pixels',
    'Image generation cancelled.',
    'Image generated: but no address',
  ])('refuses %s', (r) => expect(generatedOk(r)).toBe(false))
})
