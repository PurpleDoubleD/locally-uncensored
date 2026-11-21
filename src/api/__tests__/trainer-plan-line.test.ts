import { describe, expect, it } from 'vitest'
import { trainerPlanLine } from '../trainer'

const plan = (over = {}) => ({
  items: [{ label: 'PyTorch for your graphics card', bytes: 2_500_000_000 }, { label: 'Trainer packages', bytes: 500_000_000 }],
  downloadBytes: 3_000_000_000,
  diskGib: 10,
  replacesTorch: false,
  interrupted: false,
  ...over,
})

describe('the line before the trainer setup', () => {
  it('names what loads, how big it is and the room it needs', () => {
    expect(trainerPlanLine(plan())).toBe('Loads about 2.8 GB: PyTorch for your graphics card, Trainer packages. Needs 10 GB free.')
  })
  it('says when a stopped setup is picked up', () => {
    expect(trainerPlanLine(plan({ interrupted: true }))).toMatch(/^The last setup was stopped\. Loads again about/)
  })
  it('has nothing to say when nothing is missing', () => {
    expect(trainerPlanLine(plan({ items: [], downloadBytes: 0 }))).toBeNull()
  })
})
