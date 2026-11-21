import { describe, expect, it } from 'vitest'
import { axisShift, macThreeDChoices, pcThreeDChoices, startingChoice } from '../local-3d-choice'

const trellis = { id: 'trellis2', name: 'TRELLIS.2', sizeGB: 8.5 }
const tripo = { id: 'triposr', name: 'TripoSR', sizeGB: 1.7, minRamGB: 16 }
const sf3d = { id: 'sf3d', name: 'Stable Fast 3D', sizeGB: 4, minRamGB: 16, gated: true, hasToken: false }

describe('the local 3D model for this machine', () => {
  it('says TRELLIS.2 fits a 16 GB card', () => {
    const [c] = pcThreeDChoices({ vramGb: 16, ramGb: 32 }, trellis)
    expect(c.fit).toBe('good')
    expect(c.recommended).toBe(true)
    expect(c.fitLine).toContain('16 GB')
  })

  it('counts a 12 GB card that reports a little less as 12 GB', () => {
    expect(pcThreeDChoices({ vramGb: 11.8, ramGb: 32 }, trellis)[0].fit).toBe('good')
  })

  it('warns on a smaller card and does not block it', () => {
    const [c] = pcThreeDChoices({ vramGb: 8, ramGb: 32 }, trellis)
    expect(c.fit).toBe('tight')
    expect(c.blocked).toBe(false)
  })

  it('does not claim a fit for a card it could not read', () => {
    expect(pcThreeDChoices({ vramGb: 0, ramGb: 0 }, trellis)[0].fit).toBe('unknown')
  })

  it('recommends TripoSR on a Mac without a token', () => {
    const list = macThreeDChoices({ vramGb: 0, ramGb: 36 }, [tripo, sf3d])
    expect(list.find((c) => c.recommended)?.id).toBe('triposr')
    expect(list.find((c) => c.id === 'sf3d')?.blocked).toBe(true)
  })

  it('recommends Stable Fast 3D with a token and room for it', () => {
    const list = macThreeDChoices({ vramGb: 0, ramGb: 36 }, [tripo, { ...sf3d, hasToken: true }])
    expect(list.find((c) => c.recommended)?.id).toBe('sf3d')
  })

  it('stays on TripoSR with a token on a 16 GB Mac', () => {
    const list = macThreeDChoices({ vramGb: 0, ramGb: 16 }, [tripo, { ...sf3d, hasToken: true }])
    expect(list.find((c) => c.recommended)?.id).toBe('triposr')
  })

  it('starts on what the user picked, unless that cannot be installed', () => {
    const open = macThreeDChoices({ vramGb: 0, ramGb: 36 }, [tripo, { ...sf3d, hasToken: true }])
    expect(startingChoice(open, 'triposr')).toBe('triposr')
    const locked = macThreeDChoices({ vramGb: 0, ramGb: 36 }, [tripo, sf3d])
    expect(startingChoice(locked, 'sf3d')).toBe('triposr')
    expect(startingChoice(locked, null)).toBe('triposr')
  })
})

describe('the setup card on the axis of the prompt', () => {
  it('moves by the difference of the two middles', () => {
    expect(axisShift(661, 700, 1285, 506)).toBe(39)
  })
  it('stays inside a narrow stage', () => {
    expect(axisShift(300, 400, 520, 500)).toBe(10)
  })
  it('does not move when there is no room', () => {
    expect(axisShift(300, 400, 400, 500)).toBe(0)
  })
})
