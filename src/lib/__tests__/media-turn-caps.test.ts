/**
 * D6 (Discord 05.11.2026): after a declined video_generate call and "try
 * again", the chat said "video generated" and there was no video. The retry
 * carried no video word, the turn's video limit was 0, the call was dropped,
 * and the model was told the media was "already created and shown".
 *
 * Run: npx vitest run src/lib/__tests__/media-turn-caps.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mediaTurnCaps, droppedMediaNote } from '../media-turn-caps'

describe('D6: what one agent turn may make', () => {
  it('"try again" after a declined clip leaves one clip open', () => {
    expect(mediaTurnCaps({ wantsImage: false, wantsVideo: false, videoAllowed: true }).maxVideo).toBe(1)
  })

  it('a message that asks for a picture only still makes no clip', () => {
    expect(mediaTurnCaps({ wantsImage: true, wantsVideo: false, videoAllowed: true })).toEqual({ maxImage: 1, maxVideo: 0 })
  })

  it('a clip request makes no detour picture, and video off makes no clip', () => {
    expect(mediaTurnCaps({ wantsImage: false, wantsVideo: true, videoAllowed: true })).toEqual({ maxImage: 0, maxVideo: 1 })
    expect(mediaTurnCaps({ wantsImage: false, wantsVideo: true, videoAllowed: false }).maxVideo).toBe(0)
    expect(mediaTurnCaps({ wantsImage: false, wantsVideo: false, videoAllowed: false }).maxVideo).toBe(0)
  })
})

describe('D6: the note after a dropped media call is true', () => {
  it('nothing made this turn: it says so and forbids claiming otherwise', () => {
    const note = droppedMediaNote({ imagesDone: 0, videosDone: 0, droppedVideo: true, videoAllowed: true })
    expect(note).not.toMatch(/already created/)
    expect(note).toMatch(/nothing was generated/)
    expect(note).toMatch(/Do not say that a picture or a clip was created/)
  })

  it('video switched off: the reason is named', () => {
    expect(droppedMediaNote({ imagesDone: 0, videosDone: 0, droppedVideo: true, videoAllowed: false })).toMatch(/switched off in the tool permissions/)
  })

  it('a second call after a delivered clip still gets the closing line', () => {
    expect(droppedMediaNote({ imagesDone: 0, videosDone: 1, droppedVideo: true, videoAllowed: true })).toMatch(/already created and shown/)
  })

  it('the agent loop takes both from here', () => {
    const src = readFileSync(resolve(__dirname, '../../hooks/useAgentChat.ts'), 'utf8')
    expect(src).toMatch(/mediaTurnCaps\(\{ wantsImage, wantsVideo, videoAllowed \}\)/)
    expect(src).toMatch(/droppedMediaNote\(\{ imagesDone: imageGenDone, videosDone: videoGenDone, droppedVideo, videoAllowed \}\)/)
    expect(src).not.toMatch(/'Stop, the media you were asked for is already created/)
  })
})
