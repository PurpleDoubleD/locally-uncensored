/**
 * Fall E7 (07.11.2026): a customer trained two characters in the desktop app,
 * both trainings went through and both characters are on his account, yet the
 * app showed "No characters yet" each time and the photos were gone.
 *
 * The render worker marks a training done first and writes the character to
 * the shelf about a second later. The app read the shelf the moment the job
 * said done. waitForTrainedLora asks until the new character is there.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../supabase', () => ({ getAccessToken: vi.fn() }))
vi.mock('../../backend', () => ({ isTauri: () => false }))

import { shelfHasTraining, waitForTrainedLora, type CloudLora } from '../loras'

const DONE = '2026-11-07T23:48:21.651Z'

function lora(id: string, createdAt: string): CloudLora {
  return { id, name: id, trigger_word: id, base_family: 'flux', created_at: createdAt }
}

const older = lora('alt', '2026-11-07T20:00:00.000Z')
const fresh = lora('neu', '2026-11-07T23:48:22.421978+00:00')
const noSleep = () => Promise.resolve()

describe('shelfHasTraining', () => {
  it('finds the character written just after the job was done', () => {
    expect(shelfHasTraining([fresh], DONE)).toBe(true)
  })

  it('does not take an older character for the new one', () => {
    expect(shelfHasTraining([older], DONE)).toBe(false)
    expect(shelfHasTraining([], DONE)).toBe(false)
  })

  it('allows for a worker clock a little ahead of the database', () => {
    expect(shelfHasTraining([lora('x', '2026-11-07T23:48:10.000Z')], DONE)).toBe(true)
  })

  it('says no without a completion time', () => {
    expect(shelfHasTraining([fresh], null)).toBe(false)
  })
})

describe('waitForTrainedLora', () => {
  it('asks again until the new character is on the shelf', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fresh])
    const shelf = await waitForTrainedLora({ completed_at: DONE }, { list, sleep: noSleep })
    expect(shelf).toEqual([fresh])
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('does not stop at a shelf that only holds older characters', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([older])
      .mockResolvedValueOnce([fresh, older])
    const shelf = await waitForTrainedLora({ completed_at: DONE }, { list, sleep: noSleep })
    expect(shelf).toEqual([fresh, older])
  })

  it('takes a failed read as one more try', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([fresh])
    await expect(waitForTrainedLora({ completed_at: DONE }, { list, sleep: noSleep })).resolves.toEqual([fresh])
  })

  it('gives up after the waits and says so with null', async () => {
    const list = vi.fn().mockResolvedValue([older])
    const sleep = vi.fn(noSleep)
    const shelf = await waitForTrainedLora({ completed_at: DONE }, { list, sleep, waitsMs: [1, 2, 3] })
    expect(shelf).toBeNull()
    expect(list).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('stops when the run is ended', async () => {
    const ac = new AbortController()
    ac.abort()
    const list = vi.fn().mockResolvedValue([fresh])
    await expect(waitForTrainedLora({ completed_at: DONE }, { list, signal: ac.signal, sleep: noSleep })).resolves.toBeNull()
    expect(list).not.toHaveBeenCalled()
  })
})

describe('the desktop run waits for the shelf before it flips to Use character', () => {
  it('reads the shelf until the character is there, then clears the photos', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../../../hooks/useCloudCreate.ts'), 'utf8')
    const branch = src.slice(src.indexOf("if (job.status === 'succeeded' && op === 'lora-train')"))
    const waitAt = branch.indexOf('await waitForTrainedLora(job')
    expect(waitAt).toBeGreaterThan(0)
    expect(branch.indexOf('clearTrainImages()')).toBeGreaterThan(waitAt)
    expect(branch.indexOf("setCharacterTab('use')")).toBeGreaterThan(waitAt)
    expect(branch.indexOf('bumpCharactersVersion()')).toBeGreaterThan(waitAt)
  })
})
