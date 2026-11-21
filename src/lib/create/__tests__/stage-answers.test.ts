/**
 * The Create stage does not change its mind on a tab switch (3.1.3).
 *
 * Measured with answers delayed by 800 ms: the work surface first and the setup
 * card a second later, or "needs a download" and then "already here".
 *
 * Run: npx vitest run src/lib/create/__tests__/stage-answers.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  capabilityAnswer, createAnswerBook, laneFace, settleFace, threeDFace,
} from '../stage-answers'
import { stageSetupAnswer, stageShowsSetupCard, type StageGateInput } from '../../../components/create/experimental/stageGate'

const pc: StageGateInput = {
  backend: 'local', requiresModels: 'video', mlxMissing: null, connected: true,
  comfyStarting: false, modelsLoaded: true, laneModelCount: 0,
}

describe('the model question', () => {
  it('is unknown while ComfyUI has not answered', () => {
    expect(stageSetupAnswer({ ...pc, connected: null })).toBe('unknown')
  })
  it('is unknown while nobody has looked whether ComfyUI is starting', () => {
    expect(stageSetupAnswer({ ...pc, connected: false, comfyStarting: null })).toBe('unknown')
    expect(stageSetupAnswer({ ...pc, connected: false, comfyStarting: true })).toBe('unknown')
  })
  it('is setup once ComfyUI is known to be down', () => {
    expect(stageSetupAnswer({ ...pc, connected: false, comfyStarting: false })).toBe('setup')
  })
  it('is unknown while the lists are out, and answers after', () => {
    expect(stageSetupAnswer({ ...pc, modelsLoaded: false })).toBe('unknown')
    expect(stageSetupAnswer(pc)).toBe('setup')
    expect(stageSetupAnswer({ ...pc, laneModelCount: 1 })).toBe('ready')
  })
  it('does not wait for a list that failed for good', () => {
    expect(stageSetupAnswer({ ...pc, modelsLoaded: false, modelsFailed: true })).toBe('ready')
  })
  it('waits on a Mac until MLX was read', () => {
    expect(stageSetupAnswer({ ...pc, mlxHost: true, connected: null })).toBe('unknown')
    expect(stageSetupAnswer({ ...pc, mlxHost: true, connected: null, mlxMissing: { image: false, video: true } })).toBe('setup')
  })
  it('never opens the card on an unknown answer', () => {
    expect(stageShowsSetupCard({ ...pc, connected: null })).toBe(false)
    expect(stageShowsSetupCard({ ...pc, connected: false, comfyStarting: null })).toBe(false)
  })
  it('asks nothing on the cloud', () => {
    expect(stageSetupAnswer({ ...pc, backend: 'cloud', connected: null })).toBe('ready')
  })
})

describe('the node pack question', () => {
  const base = { needed: true, present: false, connected: true as boolean | null, comfyStarting: false as boolean | null }
  it('does not call a pack missing before the node list is there', () => {
    expect(capabilityAnswer({ ...base, capsPending: true })).toBe('unknown')
    expect(capabilityAnswer({ ...base, connected: null })).toBe('unknown')
    expect(capabilityAnswer({ ...base, connected: false, comfyStarting: null })).toBe('unknown')
  })
  it('says setup when it really is missing', () => {
    expect(capabilityAnswer(base)).toBe('setup')
    expect(capabilityAnswer({ ...base, connected: false })).toBe('setup')
  })
  it('is ready with the pack, or where none is needed', () => {
    expect(capabilityAnswer({ ...base, present: true, connected: null })).toBe('ready')
    expect(capabilityAnswer({ ...base, needed: false, connected: null })).toBe('ready')
  })
})

describe('the face of the stage', () => {
  it('models come before the node pack', () => {
    expect(laneFace('setup', 'setup')).toBe('models')
    expect(laneFace('unknown', 'setup')).toBe('wait')
    expect(laneFace('ready', 'setup')).toBe('capability')
    expect(laneFace('ready', 'unknown')).toBe('wait')
    expect(laneFace('ready', 'ready')).toBe('work')
  })
  it('keeps the last known face while the answer is out', () => {
    expect(settleFace('wait', 'work')).toBe('work')
    expect(settleFace('wait', 'models')).toBe('models')
    expect(settleFace('wait', undefined)).toBe('wait')
  })
  it('lets a real change through', () => {
    expect(settleFace('models', 'work')).toBe('models')
    expect(settleFace('work', 'models')).toBe('work')
  })
})

describe('the 3D tab', () => {
  it('shows no card before the check answered', () => {
    expect(threeDFace({ ready: null, mac: false, connected: true })).toBe('wait')
  })
  it('waits while ComfyUI may still be coming up', () => {
    expect(threeDFace({ ready: false, mac: false, connected: false, comfyStarting: true })).toBe('wait')
    expect(threeDFace({ ready: false, mac: false, connected: false, comfyStarting: null })).toBe('wait')
  })
  it('shows the card once it is known', () => {
    expect(threeDFace({ ready: false, mac: false, connected: false, comfyStarting: false })).toBe('setup')
    expect(threeDFace({ ready: false, mac: true, connected: null })).toBe('setup')
    expect(threeDFace({ ready: true, mac: false, connected: null })).toBe('work')
  })
})

describe('the book of answers', () => {
  it('gives back what it was told', () => {
    const book = createAnswerBook()
    expect(book.answer('a', 'work', book.ticket())).toBe(true)
    expect(book.get('a')).toBe('work')
  })
  it('refuses a late reply that was asked before a model change', () => {
    const book = createAnswerBook()
    const ticket = book.ticket()
    book.clear()
    expect(book.answer('a', 'work', ticket)).toBe(false)
    expect(book.get('a')).toBeUndefined()
  })
  it('forgets every tab when a model came or went', () => {
    const book = createAnswerBook()
    book.set('a', 'work')
    book.set('b', 'models')
    book.clear()
    expect(book.get('a')).toBeUndefined()
    expect(book.get('b')).toBeUndefined()
  })
})
