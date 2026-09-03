import { describe, expect, it } from 'vitest'
import { starterForEmptyImageLane } from '../mlx-install'

describe('starterForEmptyImageLane', () => {
  it('does not download a second model after engine setup pre-pulled one', () => {
    expect(starterForEmptyImageLane([
      { sizeGB: 2.6, installed: true, id: 'starter' },
      { sizeGB: 4.4, installed: false, id: 'next' },
    ])).toBeNull()
  })

  it('picks the smallest model when the lane really is empty', () => {
    expect(starterForEmptyImageLane([
      { sizeGB: 7, installed: false, id: 'large' },
      { sizeGB: 2.6, installed: false, id: 'starter' },
    ])?.id).toBe('starter')
  })
})
