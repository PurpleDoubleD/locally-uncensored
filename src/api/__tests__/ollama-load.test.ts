import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ localFetch: vi.fn() }))

vi.mock('../backend', () => ({
  isTauri: () => true,
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  localFetch: (...args: unknown[]) => mocks.localFetch(...args),
  localFetchStream: vi.fn(),
}))

import { loadModel } from '../ollama'

describe('loadModel', () => {
  beforeEach(() => {
    mocks.localFetch.mockReset()
    mocks.localFetch.mockResolvedValue(new Response('{}', { status: 200 }))
  })

  it('warms Ollama with LU\'s selected context window when provided', async () => {
    await loadModel('qwen:30b', 16_384)
    const options = mocks.localFetch.mock.calls[0][1] as { body: string }
    expect(JSON.parse(options.body)).toMatchObject({
      model: 'qwen:30b',
      keep_alive: '10m',
      options: { num_ctx: 16_384 },
    })
  })
})
