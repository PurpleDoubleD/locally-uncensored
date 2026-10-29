/**
 * Bug hunt C4 (Oktober 2026): Character Studio, Train new.
 *
 * A: IMG_0001..0004.png from one folder, then IMG_0001, IMG_0002, IMG_0005
 *    from another folder (other photos). The set said 5/100: the two other
 *    photos vanished without a word, because addTrainImages dropped every
 *    photo whose NAME the set already held.
 * B: one pick with two different face.png plus a.png, b.png. Both face.png
 *    landed (React warned about two children with the key face.png), and one
 *    Remove took both out of the state, sharing one caption on the way.
 *
 * Every photo now gets a name of its own (face_2.png, the way the Rust side's
 * free_stem numbers a stem), and Remove takes out exactly that one. A re-drop
 * of the very same file is still skipped.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/same-named-photos-stay-in-the-training-set.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCreateStore } from '../../../../stores/createStore'
import { mediaRefFrom } from '../mediaRef'

let minted = 0
beforeEach(() => {
  minted = 0
  globalThis.URL.createObjectURL = () => `blob:test/${++minted}`
  globalThis.URL.revokeObjectURL = () => {}
  useCreateStore.setState({ trainImages: [], trainCaptions: {}, backend: 'local' })
})

/** A photo as the file dialog hands it over: its bytes and its file's time. */
function photo(name: string, content: number, lastModified: number): File {
  return new File([new Uint8Array([content, content, content])], name, { type: 'image/png', lastModified })
}
const pick = (...files: File[]) => useCreateStore.getState().addTrainImages(files.map(mediaRefFrom))
const names = () => useCreateStore.getState().trainImages.map((i) => i.name)

describe('same-named photos in the training set', () => {
  it('A: other photos with names the set already holds join it, numbered on', () => {
    pick(...['IMG_0001', 'IMG_0002', 'IMG_0003', 'IMG_0004'].map((n) => photo(`${n}.png`, 0, 1000)))
    pick(...['IMG_0001', 'IMG_0002', 'IMG_0005'].map((n) => photo(`${n}.png`, 1, 2000)))
    expect(names()).toEqual([
      'IMG_0001.png', 'IMG_0002.png', 'IMG_0003.png', 'IMG_0004.png',
      'IMG_0001_2.png', 'IMG_0002_2.png', 'IMG_0005.png',
    ])
  })

  it('B: two face.png in one pick are two photos with two names', () => {
    pick(photo('face.png', 0, 1000), photo('face.png', 1, 1000), photo('a.png', 0, 1000), photo('b.png', 1, 1000))
    expect(names()).toEqual(['face.png', 'face_2.png', 'a.png', 'b.png'])
    expect(new Set(names()).size).toBe(4)
  })

  it('B: one Remove takes out one photo and only its caption', () => {
    pick(photo('face.png', 0, 1000), photo('face.png', 1, 1000), photo('a.png', 0, 1000), photo('b.png', 1, 1000))
    const st = useCreateStore.getState()
    st.setTrainCaption('face.png', 'smiling')
    st.setTrainCaption('face_2.png', 'in profile')
    useCreateStore.getState().removeTrainImage('face.png')
    expect(names()).toEqual(['face_2.png', 'a.png', 'b.png'])
    expect(useCreateStore.getState().trainCaptions).toEqual({ 'face_2.png': 'in profile' })
  })

  it('the very same file dropped again is still skipped', () => {
    const files = ['a.png', 'b.png'].map((n) => photo(n, 0, 1000))
    pick(...files)
    pick(...['a.png', 'b.png'].map((n) => photo(n, 0, 1000)))
    expect(names()).toEqual(['a.png', 'b.png'])
  })

  it('a numbered name does not clash with one the user already has', () => {
    pick(photo('face.png', 0, 1000), photo('face_2.png', 0, 1000))
    pick(photo('FACE.png', 1, 2000))
    expect(names()).toEqual(['face.png', 'face_2.png', 'FACE_3.png'])
  })
})
