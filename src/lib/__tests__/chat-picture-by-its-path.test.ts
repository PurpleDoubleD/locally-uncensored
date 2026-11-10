/**
 * D5 (Discord 07.11.2026): an agent in its sandbox saw the picture it had made
 * in the chat, found the file on disk and passed its full path as inputImage.
 * Every path was refused ("ComfyUI cannot read it from disk"), so the picture
 * could not be used again; only a folder workspace on ComfyUI's output got
 * around it. A path whose file is a picture of this chat is now that result.
 *
 * Run: npx vitest run src/lib/__tests__/chat-picture-by-its-path.test.ts
 */
import { describe, expect, it } from 'vitest'
import { resolveChatInputRef } from '../chat-media-refs'

const call = (toolName: string, result: string) => ({
  role: 'assistant',
  agentBlocks: [{ id: 'b', phase: 'tool_call' as const, content: '', timestamp: 1, toolCalls: [{ id: 'x', toolName, args: {}, status: 'completed' as const, timestamp: 1, result }] }],
})
const VIEW = 'http://127.0.0.1:8188/view?filename=ComfyUI_00012_.png&subfolder=&type=output'
const pic = call('image_generate', `Image generated: ComfyUI_00012_.png (prompt: "a red fox")\n${VIEW}`)
const clip = call('video_generate', 'Video generated: LU_00003_.webp (prompt: "b")\nhttp://127.0.0.1:8188/view?filename=LU_00003_.webp&subfolder=&type=output')

describe('D5: the picture this chat made, passed by its path on disk', () => {
  for (const path of [
    'C:\\Users\\a\\ComfyUI\\output\\ComfyUI_00012_.png',
    'C:/Users/a/ComfyUI/output/ComfyUI_00012_.png',
    '/home/a/ComfyUI/output/ComfyUI_00012_.png',
    'file:///C:/Users/a/ComfyUI/output/ComfyUI_00012_.png',
    'file:///Users/a/Library/Application%20Support/lu/output/comfyui_00012_.PNG',
  ]) {
    it(`"${path}" is the result of this chat, read by its own address`, () => {
      expect(resolveChatInputRef(path, [pic])).toEqual({ kind: 'result', media: { kind: 'image', name: 'ComfyUI_00012_.png', url: VIEW } })
    })
  }

  it('a clip of this chat by its path is still refused as a clip', () => {
    expect(resolveChatInputRef('C:\\ComfyUI\\output\\LU_00003_.webp', [clip])).toMatchObject({ kind: 'error', error: expect.stringMatching(/video clip/) })
  })

  it('a path to any other file is still a path, and so still refused by the tool', () => {
    expect(resolveChatInputRef('C:\\Users\\a\\Pictures\\holiday.png', [pic])).toEqual({ kind: 'path', path: 'C:\\Users\\a\\Pictures\\holiday.png' })
    expect(resolveChatInputRef('/etc/passwd', [pic])).toEqual({ kind: 'path', path: '/etc/passwd' })
  })
})
