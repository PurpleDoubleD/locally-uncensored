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

  it('serializes two file_edits of the SAME path', () => {
    const k1 = deriveSideEffectKey('file_edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' })
    const k2 = deriveSideEffectKey('file_edit', { path: '/tmp/a.txt', old_string: 'b', new_string: 'c' })
    expect(k1).toBeDefined()
    expect(k1).toBe(k2)
  })

  it('keeps file_edits of DIFFERENT paths parallel', () => {
    const k1 = deriveSideEffectKey('file_edit', { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' })
    const k2 = deriveSideEffectKey('file_edit', { path: '/tmp/b.txt', old_string: 'a', new_string: 'b' })
    expect(k1).not.toBe(k2)
  })

  // The scheduler groups by the key STRING alone (tool-executor's `groups` Map
  // is keyed by it, not by tool name), so a shared key across tools is the only
  // way to serialize a write and an edit of one file. It has to be: the edit's
  // old_string is matched against whatever the write left on disk.
  it('file_edit shares the file_write key for the same path (write+edit serialize)', () => {
    const write = deriveSideEffectKey('file_write', { path: '/tmp/a.txt', content: 'x' })
    const edit = deriveSideEffectKey('file_edit', { path: '/tmp/a.txt', old_string: 'x', new_string: 'y' })
    expect(edit).toBe(write)
  })

  it('normalizes file_edit paths exactly like file_write', () => {
    // Windows: case-insensitive + backslashes.
    expect(deriveSideEffectKey('file_edit', { path: 'C:\\Users\\me\\a.txt' }))
      .toBe(deriveSideEffectKey('file_edit', { path: 'c:/users/me/a.txt' }))
    // …and it collides with the file_write key for the same Windows path.
    expect(deriveSideEffectKey('file_edit', { path: 'C:\\Users\\me\\a.txt' }))
      .toBe(deriveSideEffectKey('file_write', { path: 'c:/users/me/a.txt', content: '' }))
    // Unix: case-sensitive.
    expect(deriveSideEffectKey('file_edit', { path: '/tmp/Foo.txt' }))
      .not.toBe(deriveSideEffectKey('file_edit', { path: '/tmp/foo.txt' }))
    // Trailing + doubled slashes collapse.
    expect(deriveSideEffectKey('file_edit', { path: '/tmp/a/' }))
      .toBe(deriveSideEffectKey('file_edit', { path: '/tmp//a' }))
  })

  it('file_edit without path falls back to the same unknown sentinel', () => {
    // Conservative: every pathless file mutation shares one serial queue.
    expect(deriveSideEffectKey('file_edit', {})).toBe('file_write:unknown')
  })

  it('shell_execute and code_execute share the "exec" queue', () => {
    expect(deriveSideEffectKey('shell_execute', { command: 'ls' })).toBe('exec')
    expect(deriveSideEffectKey('code_execute', { code: '1' })).toBe('exec')
  })

  it('repo-mutating + shelling tools also serialize on "exec" (avoid .git/index.lock races)', () => {
    expect(deriveSideEffectKey('git_commit', { message: 'x' })).toBe('exec')
    expect(deriveSideEffectKey('git_push', {})).toBe('exec')
    expect(deriveSideEffectKey('run_tests', {})).toBe('exec')
    expect(deriveSideEffectKey('shell_execute_background', { command: 'x' })).toBe('exec')
    // `gh pr create` pushes the branch — same .git/index.lock as git_push.
    expect(deriveSideEffectKey('gh_pr_create', { title: 'x' })).toBe('exec')
  })

  it('mutating-but-shell-less tools stay parallel', () => {
    // todo_write is in-memory conversation state; project_init only renders a
    // plan; a task kill must not queue behind the command it cancels.
    expect(deriveSideEffectKey('todo_write', { todos: [] })).toBeUndefined()
    expect(deriveSideEffectKey('project_init', { recipe: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('shell_task_kill', { id: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('shell_task_status', { id: 'x' })).toBeUndefined()
    expect(deriveSideEffectKey('pr_resume', { url: 'x' })).toBeUndefined()
  })

  it('read-only git tools stay parallel (no key)', () => {
    expect(deriveSideEffectKey('git_status', {})).toBeUndefined()
    expect(deriveSideEffectKey('git_log', {})).toBeUndefined()
    expect(deriveSideEffectKey('git_diff', {})).toBeUndefined()
  })

  it('image_generate, video_generate and run_workflow share the "comfyui" queue', () => {
    expect(deriveSideEffectKey('image_generate', { prompt: 'x' })).toBe('comfyui')
    // video_generate MUST serialize with image_generate (same GPU + VRAM
    // hand-off); when it was missing it ran in parallel and a back-to-back gen
    // could survive Stop.
    expect(deriveSideEffectKey('video_generate', { prompt: 'x' })).toBe('comfyui')
    expect(deriveSideEffectKey('run_workflow', { name: 'x' })).toBe('comfyui')
  })

  it('unknown tools default to no key (fully parallel)', () => {
    expect(deriveSideEffectKey('custom_tool', {})).toBeUndefined()
  })

  it('file_write without path falls back to unknown sentinel', () => {
    expect(deriveSideEffectKey('file_write', {})).toBe('file_write:unknown')
  })
})
