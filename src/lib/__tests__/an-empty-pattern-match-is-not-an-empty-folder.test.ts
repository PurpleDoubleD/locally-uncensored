import { describe, it, expect } from 'vitest'
import { emptyListAnswer } from '../../api/mcp/builtin-tools'

// CA bench AG9: Kimi listed `*.{js,mjs}` over a tree full of .js files and
// was told "The folder is empty.", which is false and steers the model wrong.
describe('file_list with nothing to show', () => {
  it('calls a folder empty only when no pattern was given', () => {
    expect(emptyListAnswer({ path: 'projekt' })).toBe('The folder is empty.')
  })
  it('says the pattern matched nothing and how to look deeper', () => {
    const a = emptyListAnswer({ path: 'projekt', pattern: '*.js' })
    expect(a).not.toMatch(/empty/)
    expect(a).toMatch(/\*\*\/\*\.js/)
  })
  it('does not suggest recursion that already happened', () => {
    const a = emptyListAnswer({ path: 'projekt', pattern: '*.{js,mjs}', recursive: true })
    expect(a).toMatch(/subfolders/)
    expect(a).not.toMatch(/set recursive/)
  })
})
