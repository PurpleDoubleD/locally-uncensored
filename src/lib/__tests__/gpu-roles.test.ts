import { describe, it, expect } from 'vitest'
import { normalizeGpuRoles, gpuRolesSeparate, sameCard, NO_GPU_ROLES, comfySplitOf, comfyCards } from '../gpu-roles'

const a = { vendor: 'nvidia' as const, index: 0, name: 'RTX 4090' }
const b = { vendor: 'nvidia' as const, index: 1, name: 'RTX 3060' }

describe('gpu roles', () => {
  it('anything unreadable is no pick', () => {
    expect(normalizeGpuRoles(undefined)).toEqual(NO_GPU_ROLES)
    expect(normalizeGpuRoles('x')).toEqual(NO_GPU_ROLES)
    expect(normalizeGpuRoles({ chat: { vendor: 'apple', index: 0 } })).toEqual(NO_GPU_ROLES)
    expect(normalizeGpuRoles({ chat: { vendor: 'nvidia', index: -1 } })).toEqual(NO_GPU_ROLES)
    expect(normalizeGpuRoles({ chat: { vendor: 'nvidia', index: 1.5 } })).toEqual(NO_GPU_ROLES)
  })

  it('a stored pick survives, a missing name reads as empty', () => {
    expect(normalizeGpuRoles({ chat: a, comfy: { vendor: 'amd', index: '1' } })).toEqual({
      chat: a,
      comfy: { vendor: 'amd', index: 1, name: '' },
    })
  })

  it('apart only with both pinned to different cards', () => {
    expect(gpuRolesSeparate({ chat: a, comfy: b })).toBe(true)
    expect(gpuRolesSeparate({ chat: a, comfy: { ...a, name: 'other label' } })).toBe(false)
    expect(gpuRolesSeparate({ chat: a, comfy: null })).toBe(false)
    expect(gpuRolesSeparate({ chat: null, comfy: b })).toBe(false)
    expect(gpuRolesSeparate(undefined)).toBe(false)
    // Same index, other vendor: two different cards.
    expect(gpuRolesSeparate({ chat: a, comfy: { vendor: 'amd', index: 0, name: 'RX' } })).toBe(true)
    expect(sameCard(a, null)).toBe(false)
  })

  // C56 (3.1.0): one model across two cards.
  const c = { vendor: 'nvidia' as const, index: 2, name: 'RTX 5080' }

  it('a stored split survives only as two different NVIDIA cards', () => {
    expect(normalizeGpuRoles({ chat: null, comfy: null, comfySplit: { model: a, helper: b } })).toEqual({
      chat: null, comfy: null, comfySplit: { model: a, helper: b },
    })
    // Same card, AMD, half a split: gone, the rest stays.
    expect(normalizeGpuRoles({ chat: a, comfySplit: { model: a, helper: a } })).toEqual({ chat: a, comfy: null })
    expect(normalizeGpuRoles({ comfySplit: { model: { ...a, vendor: 'amd' }, helper: { ...b, vendor: 'amd' } } })).toEqual(NO_GPU_ROLES)
    expect(normalizeGpuRoles({ comfySplit: { model: a } })).toEqual(NO_GPU_ROLES)
    expect(comfySplitOf({ chat: null, comfy: null })).toBeNull()
  })

  it('a split ComfyUI holds both its cards, the chat is apart only on a third', () => {
    const split = { model: a, helper: b }
    expect(comfyCards({ chat: null, comfy: c, comfySplit: split })).toEqual([a, b])
    expect(gpuRolesSeparate({ chat: c, comfy: null, comfySplit: split })).toBe(true)
    expect(gpuRolesSeparate({ chat: a, comfy: null, comfySplit: split })).toBe(false)
    expect(gpuRolesSeparate({ chat: b, comfy: c, comfySplit: split })).toBe(false)
    expect(gpuRolesSeparate({ chat: null, comfy: null, comfySplit: split })).toBe(false)
  })
})
