/**
 * On Windows an approved change was refused because of line endings.
 *
 * Morgan's report was "the plan says done and nothing was written". The first
 * fix taught `reconcile` to merge a foreign edit instead of refusing it. Then
 * the real queue was measured on the Windows box on 2026-08-14 and the same
 * report came back in a narrower shape: `oldContent` and the file on disk both
 * carry CRLF, because that is what Windows editors write, while the model
 * writes `newContent` with plain LF. Every single line then differs from the
 * baseline, `mergeThreeWay` sees one giant replaced block, and a foreign edit
 * in the middle of the file collides with it. The user is told their edit
 * touches the same place, which is false: the two changes never met.
 *
 * A second, quieter half of the same bug: even with no foreign edit at all, the
 * approved LF content was written over a CRLF file, so the whole file flipped
 * its line endings and showed up in git as fully rewritten.
 *
 * So the comparison and the merge run on one normalized form, and the result is
 * written back in the form the FILE has, not the form the model happened to use.
 *
 * Run: npx vitest run src/lib/__tests__/staged-apply-crlf.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({
  backendCall: vi.fn(),
}))
const { addMessage } = vi.hoisted(() => ({ addMessage: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ addMessage }) },
}))

import { backendCall } from '../../api/backend'
import { applyStagedChange } from '../staged-apply'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'

const call = backendCall as unknown as ReturnType<typeof vi.fn>
const CHAT = 'chat-crlf'

/** Route fs_read to the file on disk, fs_write to a recorder. */
function onDisk(content: string) {
  const written: string[] = []
  call.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'fs_read') return { content }
    if (cmd === 'fs_write') {
      written.push(String(args.content))
      return { status: 'saved', path: args.path }
    }
    return null
  })
  return written
}

const crlf = (lines: string[]) => lines.join('\r\n')
const lf = (lines: string[]) => lines.join('\n')

const BASE = ['import os', '', 'def main():', '    print("hi")', '', 'main()']

describe('an approved change lands on a CRLF file', () => {
  beforeEach(() => {
    call.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
  })

  function stageEdit(newContent: string, oldContent: string) {
    useStagedChangesStore.getState().stage(CHAT, {
      path: 'app.py',
      resolvedPath: '/proj/app.py',
      workingDirectory: '/proj',
      oldContent,
      newContent,
      diff: '',
    })
    return useStagedChangesStore.getState().list(CHAT)[0]
  }

  it('merges a foreign edit elsewhere instead of calling it a collision', async () => {
    // Someone changed the FIRST line on disk. The model changed the print.
    // Different places, so both must survive.
    const disk = crlf(['import os, sys', '', 'def main():', '    print("hi")', '', 'main()'])
    const model = lf(['import os', '', 'def main():', '    print("hello")', '', 'main()'])
    const written = onDisk(disk)

    await applyStagedChange(CHAT, stageEdit(model, crlf(BASE)))

    expect(written).toHaveLength(1)
    expect(written[0]).toContain('import os, sys')
    expect(written[0]).toContain('print("hello")')
  })

  it('writes the merged file back with the line endings the file had', async () => {
    const disk = crlf(['import os, sys', '', 'def main():', '    print("hi")', '', 'main()'])
    const model = lf(['import os', '', 'def main():', '    print("hello")', '', 'main()'])
    const written = onDisk(disk)

    await applyStagedChange(CHAT, stageEdit(model, crlf(BASE)))

    expect(written[0]).toContain('\r\n')
    expect(written[0].replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('keeps CRLF even when nothing else touched the file', async () => {
    // The quiet half: no merge involved, the file just must not flip to LF and
    // show up as rewritten from top to bottom.
    const disk = crlf(BASE)
    const model = lf(['import os', '', 'def main():', '    print("hello")', '', 'main()'])
    const written = onDisk(disk)

    await applyStagedChange(CHAT, stageEdit(model, crlf(BASE)))

    expect(written[0]).toContain('print("hello")')
    expect(written[0]).toContain('\r\n')
    expect(written[0].replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('leaves an LF file on LF', async () => {
    const disk = lf(BASE)
    const model = lf(['import os', '', 'def main():', '    print("hello")', '', 'main()'])
    const written = onDisk(disk)

    await applyStagedChange(CHAT, stageEdit(model, lf(BASE)))

    expect(written[0]).not.toContain('\r')
  })

  it('merges a foreign edit in the MIDDLE of a longer CRLF file', async () => {
    // The open line from the E2E list, written down on 2026-08-11 from Morgan's
    // run: on Windows only an edit at the very END of the file survived,
    // because CRLF against the model's LF made the whole file look like one
    // changed block, and anything foreign further up read as a collision.
    // A file long enough that a middle edit and the model's edit sit in clearly
    // different regions, so nothing but the line endings can decide this.
    const base = [
      'import os',
      'import sys',
      '',
      'def load(path):',
      '    with open(path) as f:',
      '        return f.read()',
      '',
      'def main():',
      '    data = load("in.txt")',
      '    print("hi")',
      '',
      'main()',
    ]
    // Someone fixed the middle of the file by hand while the change sat in the
    // queue. The model, minutes earlier, had touched the print near the bottom.
    const disk = crlf(base.map((l) => (l === '    with open(path) as f:' ? '    with open(path, encoding="utf-8") as f:' : l)))
    const model = lf(base.map((l) => (l === '    print("hi")' ? '    print("hello")' : l)))
    const written = onDisk(disk)

    await applyStagedChange(CHAT, stageEdit(model, crlf(base)))

    expect(written).toHaveLength(1)
    expect(written[0]).toContain('encoding="utf-8"')
    expect(written[0]).toContain('print("hello")')
    // and it went back as a Windows file, not as one long LF block
    expect(written[0].split('\r\n')).toHaveLength(base.length)
  })

  it('still refuses when the two edits really are the same line', async () => {
    // Normalizing must not turn a real collision into a silent overwrite.
    const disk = crlf(['import os', '', 'def main():', '    print("from disk")', '', 'main()'])
    const model = lf(['import os', '', 'def main():', '    print("from model")', '', 'main()'])
    onDisk(disk)

    await expect(applyStagedChange(CHAT, stageEdit(model, crlf(BASE)))).rejects.toThrow(
      /changed on disk/,
    )
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(1)
  })
})
