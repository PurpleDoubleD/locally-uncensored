// Scene to Video on the desktop (3.1.3): the role and catalogue taken over
// from the live web, the rules the cloud run shares with it, and the rules
// of the local lane (Wan 2.1 VACE in ComfyUI).

import { beforeEach, describe, expect, it } from 'vitest'
import { STUDIO_MODELS, studioFields } from '../studio-contract'
import { presetModels, roleForModel, SCENE_ROLE_MODELS, modelHint } from '../preset-models'
import { intentPickerModels, intentRoles } from '../create-studio'
import { intentToJob } from '../cloud-jobs'
import {
  SCENE_DEFAULT_MODEL, SCENE_FRAME_MODEL, SCENE_LOCAL_MAX_SECONDS, sceneClipSeconds, sceneFixedOptions,
  sceneFormatProblem, sceneFramePrompt, sceneLengthProblem, sceneLocalFrames, sceneLocalProblem, sceneLocalSize,
  sceneLocalTrimNote, sceneLookPrompt, scenePanelFields, sceneProblem, scenePrompt, sceneReadsFrame, sceneSizeProblem,
} from '../scene'
import { sceneFrameFor, sceneFrameSubmit } from '../../create/scene-frame'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { EMPTY_SCENE } from '../../../stores/createStore'
import { neuerServer } from './fixtures/test-catalogs'

beforeEach(() => {
  useCloudCatalogStore.setState({ models: neuerServer() })
})

describe('the scene role and its catalogue', () => {
  it('carries the five models of the web, in the web order, Wan 3.0 Scene first', () => {
    expect(SCENE_ROLE_MODELS).toEqual(['wan-3.0-video-edit', 'seedance-2.5-flash-video-edit', 'wan-2.1-vace', 'aleph-2', 'flux-3-video-edit'])
    expect(SCENE_DEFAULT_MODEL).toBe('wan-3.0-video-edit')
    for (const id of SCENE_ROLE_MODELS) {
      expect(STUDIO_MODELS[id], id).toBeDefined()
      expect(STUDIO_MODELS[id].kind).toBe('video')
      expect(Object.values(STUDIO_MODELS[id].inputs)).toContain('video_path')
      expect(roleForModel(id)).toBe('scene')
      expect(modelHint(id), id).toBeTruthy()
    }
  })

  it('is the role of the Scene tab, and its picker lists the role in order', () => {
    expect(intentRoles('scene')).toEqual(['scene'])
    expect(presetModels('scene').map((m) => m.id)).toEqual([...SCENE_ROLE_MODELS])
    expect(intentPickerModels('scene').map((m) => m.id)).toEqual([...SCENE_ROLE_MODELS])
  })

  it('runs as a studio video job', () => {
    expect(intentToJob('scene')).toEqual({ kind: 'video', op: 'studio' })
  })

  it('a server that does not list the models yet offers none (the start then says so)', () => {
    useCloudCatalogStore.setState({ models: neuerServer().filter((m) => !SCENE_ROLE_MODELS.includes(m.id)) })
    expect(intentPickerModels('scene')).toEqual([])
  })
})

describe('the cloud rules, the same as the web', () => {
  it('a clip runs 2 to 10 seconds, a longer one is cut', () => {
    expect(sceneLengthProblem(1.5)).toMatch(/1\.5 seconds long/)
    expect(sceneLengthProblem(2)).toBeNull()
    expect(sceneLengthProblem(14)).toBeNull()
    expect(sceneClipSeconds(14)).toBe(10)
  })

  it('names what each model refuses: Aleph over 16 MB, FLUX 3 without MP4', () => {
    expect(sceneSizeProblem('aleph-2', 17 * 1024 * 1024)).toMatch(/under 16 MB/)
    expect(sceneSizeProblem('wan-3.0-video-edit', 17 * 1024 * 1024)).toBeNull()
    expect(sceneFormatProblem('flux-3-video-edit', 'scene.mov')).toMatch(/MP4 only/)
    expect(sceneFormatProblem('flux-3-video-edit', 'scene.mp4')).toBeNull()
  })

  it('stops a run without video first, then without words', () => {
    expect(sceneProblem({ model: SCENE_DEFAULT_MODEL, prompt: 'x', hasVideo: false })).toBe('Add your scene video first.')
    expect(sceneProblem({ model: SCENE_DEFAULT_MODEL, prompt: ' ', hasVideo: true, seconds: 5 })).toBe('Describe the look of your scene.')
    expect(sceneProblem({ model: SCENE_DEFAULT_MODEL, prompt: 'a city', hasVideo: true, seconds: 5, bytes: 1000, name: 'a.mov' })).toBeNull()
  })

  it('sets VACE length and size from the clip, and hides those fields in the settings', () => {
    const opts = sceneFixedOptions('wan-2.1-vace', { seconds: 7.4, width: 720, height: 1280 }, false)
    expect(opts.size).toBe('720*1280')
    const field = studioFields('wan-2.1-vace').duration
    expect(field).toBeDefined()
    expect(scenePanelFields('wan-2.1-vace')).toEqual(['duration', 'size', 'keyframe_positions'])
    expect(sceneFixedOptions('aleph-2', { seconds: 5 }, true).keyframe_positions).toEqual(['first'])
    expect(sceneFixedOptions('aleph-2', { seconds: 5 }, false).keyframe_positions).toEqual([])
  })

  it('tells a video editor to keep the camera and names the first frame; VACE reads the look alone', () => {
    expect(scenePrompt('wan-3.0-video-edit', 'a city at night', true))
      .toBe('a city at night The reference image shows the first frame. Keep the camera movement, the timing, the framing and the position of every object from the video.')
    expect(scenePrompt('wan-2.1-vace', 'a city at night', true)).toBe('a city at night')
    expect(sceneReadsFrame('flux-3-video-edit')).toBe(false)
    expect(sceneReadsFrame('wan-3.0-video-edit')).toBe(true)
  })

  it('writes the prompt from a look and a style', () => {
    expect(sceneLookPrompt('product', 'anime')).toMatch(/^Glossy amber glass bottle.*, hand-drawn anime style/)
    expect(sceneLookPrompt(null, 'noir')).toMatch(/^film noir/)
    expect(sceneLookPrompt(null, null)).toBe('')
  })

  it('the first frame step runs GPT Image 2 Edit with the restyle addition and a ceiling', () => {
    expect(SCENE_FRAME_MODEL).toBe('gpt-image-2-edit')
    const body = sceneFrameSubmit('user/frame.jpg', { first: { url: 'data:,', width: 1280, height: 720 }, look: 'a forest.', credits: 7000 })
    expect(body.model).toBe('gpt-image-2-edit')
    expect(body.prompt).toBe(sceneFramePrompt('a forest.'))
    expect(body.prompt).toMatch(/^a forest\. Restyle this exact frame\./)
    expect(body.params.max_credits).toBe(7000)
    expect(body.params.image_paths ?? body.params.source_path).toBeTruthy()
  })

  it('an own frame counts only for the scene video it belongs to', () => {
    const frame = { kind: 'upload' as const, url: 'data:,', width: 1, height: 1, videoUrl: 'blob:a' }
    expect(sceneFrameFor({ ...EMPTY_SCENE, frame }, 'blob:a')).toBe(frame)
    expect(sceneFrameFor({ ...EMPTY_SCENE, frame }, 'blob:b')).toBeNull()
    expect(sceneFrameFor({ ...EMPTY_SCENE, frame }, undefined)).toBeNull()
  })
})

describe('the local lane (Wan 2.1 VACE)', () => {
  it('renders at most five seconds at 16 fps, on the Wan grid, never past the clip', () => {
    expect(SCENE_LOCAL_MAX_SECONDS).toBe(5)
    expect(sceneLocalFrames(5)).toBe(77)
    expect(sceneLocalFrames(5.1)).toBe(81)
    expect(sceneLocalFrames(10)).toBe(81)
    expect(sceneLocalFrames(2)).toBe(29)
    expect(sceneLocalFrames(undefined)).toBe(77)
    for (const s of [2, 2.5, 3.3, 4, 4.9, 7]) {
      const f = sceneLocalFrames(s)
      expect((f - 1) % 4).toBe(0)
      expect(f).toBeLessThanOrEqual(Math.min(s, 5.0625) * 16 + 0.001)
    }
  })

  it('renders VACE 1.3B sizes in the shape of the clip', () => {
    expect(sceneLocalSize(1920, 1080)).toEqual({ width: 832, height: 480 })
    expect(sceneLocalSize(720, 1280)).toEqual({ width: 480, height: 832 })
    expect(sceneLocalSize(1000, 1000)).toEqual({ width: 624, height: 624 })
    expect(sceneLocalSize()).toEqual({ width: 832, height: 480 })
  })

  it('says when the PC renders less than the clip', () => {
    expect(sceneLocalTrimNote(4)).toBeNull()
    expect(sceneLocalTrimNote(8)).toBe('Longer than 5 s: your PC renders the first 5 s.')
  })

  it('stops a local run without video, too short, or without words', () => {
    expect(sceneLocalProblem({ hasVideo: false, prompt: 'x' })).toBe('Add your scene video first.')
    expect(sceneLocalProblem({ hasVideo: true, seconds: 1, prompt: 'x' })).toMatch(/2 to 10 seconds/)
    expect(sceneLocalProblem({ hasVideo: true, seconds: 4, prompt: '' })).toBe('Describe the look of your scene.')
    expect(sceneLocalProblem({ hasVideo: true, seconds: 4, prompt: 'a room' })).toBeNull()
  })
})
