import { describe, it, expect } from 'vitest'
import { explainError, __internal } from '../error-hints'

describe('error-hints — explainError', () => {
  it('returns undefined for empty input', () => {
    expect(explainError('file_read', '')).toBeUndefined()
    expect(explainError('', 'anything')).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(explainError('file_read', 'some totally unrelated error')).toBeUndefined()
  })

  it.each([
    ['file_read', 'Error: ENOENT: no such file or directory, open /x', /file_list/i],
    ['file_read', 'permission denied: /etc/shadow', /permission|workspace/i],
    ['file_read', 'EISDIR: illegal operation on a directory', /directory, not a file|file_list/i],
    ['file_write', 'ENOSPC: no space left on device', /disk full/i],
    ['file_write', 'EROFS: read-only file system', /read-only/i],
    ['file_list', 'ENOTDIR: not a directory', /file_read/i],
    ['file_search', 'invalid regex: unmatched parenthesis', /regex|escape/i],
    ['shell_execute', "'foo' is not recognized as an internal or external command", /installed|PATH/i],
    ['shell_execute', 'Command timed out after 120s', /break|timeout/i],
    ['code_execute', 'SyntaxError: invalid syntax', /syntax|indent/i],
    ['code_execute', 'ModuleNotFoundError: No module named numpy', /stdlib|pip install/i],
    ['code_execute', "NameError: name 'x' is not defined", /persist|redefine/i],
    ['web_fetch', 'refused: private IP 192.168.1.1', /public|https/i],
    ['web_fetch', 'Error 404: page not found', /web_search/i],
    ['web_fetch', 'Error 403: forbidden', /different source/i],
    ['web_search', 'Unauthorized 401: check api key', /Brave|Tavily|Settings/i],
    ['web_search', 'Rate limit 429', /Rate limited|wait/i],
    ['image_generate', 'No image models available in ComfyUI.', /Model Manager|install/i],
    ['image_generate', 'CUDA out of memory', /GPU|resolution/i],
    ['run_workflow', 'Workflow "foo" not found. Available: bar, baz', /available|pick one/i],
  ])('maps %s error → hint: %s', (tool, err, re) => {
    const hint = explainError(tool, err)
    expect(hint, `expected a hint for ${tool} / ${err}`).toBeDefined()
    expect(hint).toMatch(re)
  })

  it('falls back to generic network hint for unknown tool', () => {
    expect(explainError('unknown_tool', 'fetch failed: ECONNREFUSED')).toMatch(/network/i)
  })

  it('generic timeout hint triggers when per-tool has nothing', () => {
    expect(explainError('system_info', 'ETIMEDOUT')).toMatch(/time|narrow/i)
  })

  it('per-tool rule wins over generic rule', () => {
    // shell_execute has a specific timeout hint — make sure it takes precedence.
    const hint = explainError('shell_execute', 'timed out')
    expect(hint).toMatch(/break|timeout/i)
  })

  it('every built-in tool has at least one hint OR an explicit empty list (Phase 3 coverage)', () => {
    const expected = [
      'file_read', 'file_write', 'file_list', 'file_search',
      'shell_execute', 'code_execute',
      'web_search', 'web_fetch',
      'system_info', 'process_list', 'screenshot',
      'image_generate', 'run_workflow', 'get_current_time',
    ]
    for (const name of expected) {
      expect(Object.hasOwn(__internal.TOOL_HINTS, name), `missing entry for ${name}`).toBe(true)
    }
  })

  it('every hint string is short (≤ 160 chars)', () => {
    const allHints: string[] = []
    for (const rules of Object.values(__internal.TOOL_HINTS)) {
      for (const r of rules) allHints.push(r.hint)
    }
    for (const r of __internal.GENERIC_HINTS) allHints.push(r.hint)
    for (const h of allHints) {
      expect(h.length, `hint too long: "${h}"`).toBeLessThanOrEqual(160)
    }
  })
})
