/**
 * The sentence of the frame step for open editors (real test of 14.11.2026,
 * port of the web's swap-open-prompt.test.ts): the photos are only face
 * references, the first image stays the base. The two person text must match
 * the real test exactly. And "Check first frame" follows "Uncensored".
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { swapFramePrompt, SWAP_FRAME_MODEL, SWAP_FRAME_OPEN_MODEL } from '../../render/swap'
import { swapFrameSubmit } from '../swap-frame'
import { useSwapOneClick } from '../swap-one-click'

// Real test 14.11.2026: exactly this sentence ran with Qwen Image 2.1 Edit.
const V2 = "The first image is a frame from a video and is the base image. The second and third images are only face references: do not copy their clothing, body, pose, background or framing. Edit only the first image: give the person on the left the face and hair of the person from the second image, and give the person on the right the face and hair of the person from the third image. Keep the face identity and facial features of each new person exactly. Remove all of the original people's hair completely, even long hair. Keep every person in the first image exactly where they are, with the same body, pose, head angle, head size, hands, clothing, mouth position, lighting, colors, camera angle, framing, distance and background. No headsets, no microphones. Every other person stays unchanged. It must look like the same raw phone video frame, just with the other faces."

const req = (frameModel: string) => ({
  frame: { url: 'data:image/jpeg;base64,AA', width: 1280, height: 720 },
  figures: [
    { imageUrl: 'data:image/png;base64,AA', role: '', mark: { x: 0.3, y: 0.4 } },
    { imageUrl: 'data:image/png;base64,AA', role: '', mark: { x: 0.7, y: 0.4 } },
  ],
  model: '', consent: true, credits: 1000, frameModel,
})

describe('the frame sentence for open editors', () => {
  it('two people: exactly the sentence of the real test', () => {
    expect(swapFramePrompt(['the person on the left', 'the person on the right'], undefined, { open: true })).toBe(V2)
  })
  it('one person: the photo only as a face reference, the clothing stays', () => {
    const p = swapFramePrompt(['the person'], undefined, { open: true })
    expect(p).toContain('The second image is only a face reference')
    expect(p).toContain('give the person the face and hair of the person from the second image')
    expect(p).toContain('same body, pose')
    expect(p).toMatch(/other face\.$/)
  })
  it('three people count the images right', () => {
    const p = swapFramePrompt(['a', 'b', 'c'], undefined, { open: true })
    expect(p).toContain('The second, third and fourth images are only face references')
    expect(p).toContain('give c the face and hair of the person from the fourth image')
  })
  it("the customer's fix goes at the end", () => {
    expect(swapFramePrompt(['the person'], 'keep the cap', { open: true })).toMatch(/Fix this from the last attempt: keep the cap$/)
  })
  it('without open the Nano sentence stays as it was', () => {
    expect(swapFramePrompt(['the person'])).toContain('Replace the person in the first image')
  })
  it('the frame step sends the open sentence to every editor but Nano Banana Pro', () => {
    expect(swapFrameSubmit('f', ['a', 'b'], req(SWAP_FRAME_OPEN_MODEL)).prompt).toBe(V2)
    expect(swapFrameSubmit('f', ['a', 'b'], req(SWAP_FRAME_MODEL)).prompt).toMatch(/^In the first image, replace the person on the left/)
  })
})

describe('Check first frame follows Uncensored', () => {
  beforeEach(() => useSwapOneClick.setState({ openModels: false, check: false, checkTouched: false }))
  it('Uncensored on turns the check on, off turns it off again', () => {
    useSwapOneClick.getState().setOpenModels(true)
    expect(useSwapOneClick.getState().check).toBe(true)
    useSwapOneClick.getState().setOpenModels(false)
    expect(useSwapOneClick.getState().check).toBe(false)
  })
  it('filtered the check stays off', () => {
    expect(useSwapOneClick.getState().check).toBe(false)
  })
  it('set by hand it no longer follows', () => {
    useSwapOneClick.getState().setCheck(true)
    useSwapOneClick.getState().setOpenModels(true)
    useSwapOneClick.getState().setOpenModels(false)
    expect(useSwapOneClick.getState().check).toBe(true)
  })
})
