import { describe, it, expect } from 'vitest'
import { deriveSideEffectKey } from '../side-effect-key'

describe('side-effect-key', () => {
  it('returns undefined for pure reads (parallel-safe)', () => {
    expect(deriveSideEffectKey('file_read', { path: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('file_list', { path: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('file_search', { path: 'x', pattern: 'y' })).toBeUndefined()
    expect(deriveSideEffectKey('web_search', { query: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('web_fetch', { url: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('system_info', {})).toBeUndefined()
    expect(deriveSideEffectKey('process_list', {})).toBeUndefined()
    expect(deriveSideEffectKey('get_current_time', {})).toBeUndefined()
    expect(deriveSideEffectKey('screenshot', {})).toBeUndefined()
  })

  it('returns path-specific key for file_write', () => {
    const k1 = deriveSideEffectKey('file_write', { path: '/tmp/a.txt', content: '' })
    const k2 = deriveSideEffectKey('file_write', { path: '/tmp/b.txt', content: '' })
    expect(k1).not.toBe(k2)
    expect(k1?.startsWith('file_write:')).toBe(true)
  })

  it('collapses different-case Windows paths to the same key', () => {
    const k1 = deriveSideEffectKey('file_write', { path: 'C:\\Users\\me\\a.txt', content: '' })
    const k2 = deriveSideEffectKey('file_write', { path: 'c:/users/me/a.txt', content: '' })
    expect(k1).toBe(k2)
  })

  it('collapses trailing slash + double slash', () => {
    const k1 = deriveSideEffectKey('file_write', { path: '/tmp/a/', content: '' })
    const k2 = deriveSideEffectKey('file_write', { path: '/tmp//a', content: '' })
    expect(k1).toBe(k2)
  })

  it('preserves case on Unix paths', () => {
    const k1 = deriveSideEffectKey('file_write', { path: '/tmp/Foo.txt', content: '' })
    const k2 = deriveSideEffectKey('file_write', { path: '/tmp/foo.txt', content: '' })
    expect(k1).not.toBe(k2)
  })

  it('shell_execute and code_execute share the "exec" queue', () => {
    expect(deriveSideEffectKey('shell_execute', { command: 'ls' })).toBe('exec')
    expect(deriveSideEffectKey('code_execute', { code: '1' })).toBe('exec')
  })

  it('image_generate and run_workflow share the "comfyui" queue', () => {
    expect(deriveSideEffectKey('image_generate', { prompt: 'x' })).toBe('comfyui')
    expect(deriveSideEffectKey('run_workflow', { name: 'x' })).toBe('comfyui')
  })

  it('unknown tools default to no key (fully parallel)', () => {
    expect(deriveSideEffectKey('custom_tool', {})).toBeUndefined()
  })

  it('file_write without path falls back to unknown sentinel', () => {
    expect(deriveSideEffectKey('file_write', {})).toBe('file_write:unknown')
  })
})
