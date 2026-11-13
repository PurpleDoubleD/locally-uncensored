/**
 * GitHub #196: ComfyUI queues a prompt as soon as one output node passes
 * validation and answers 200, listing the failed outputs in node_errors
 * (execution.py validate_prompt, server.py post_prompt of v0.42.4). In the
 * LTX 2.5 template the prompt preview passed and Save Video did not, so LU
 * waited for a run that could only end with "no output was produced".
 * Such a prompt is now taken back out of the queue and reported like a full
 * rejection.
 *
 * Run: npx vitest run src/api/__tests__/a-half-valid-prompt-is-a-rejection.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn<(url: string, opts?: { method?: string; body?: string }) => Promise<Response>>()

vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...(a as [string, { method?: string; body?: string }])),
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  isMacOS: () => false,
}))

import { submitWorkflow } from '../comfyui'

const saveVideoError = {
  '75': {
    errors: [{
      type: 'value_not_in_list',
      message: 'Value not in list',
      details: "vae_name: 'ltx-2.5-video-vae-bf16.safetensors' not in ['a.safetensors', 'b.safetensors']",
    }],
    dependent_outputs: ['75'],
    class_type: 'SaveVideo',
  },
}

function answer(promptAnswer: { status: number; body: unknown }) {
  localFetch.mockImplementation(async (url = '') => {
    if (url.endsWith('/prompt')) return new Response(JSON.stringify(promptAnswer.body), { status: promptAnswer.status })
    if (url.endsWith('/queue')) return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  })
}

const graph = { '1': { class_type: 'SaveVideo', inputs: { filename_prefix: 'x' } } }

beforeEach(() => localFetch.mockReset())

describe('a 200 from /prompt with node_errors', () => {
  it('throws with the same wording as a full rejection and deletes the prompt from the queue', async () => {
    answer({ status: 200, body: { prompt_id: 'p-half', number: 3, node_errors: saveVideoError } })
    await expect(submitWorkflow(graph, 'lu-test')).rejects.toThrow(
      "ComfyUI rejected workflow: Node 75 (SaveVideo): Value not in list (vae_name: 'ltx-2.5-video-vae-bf16.safetensors')",
    )
    const del = localFetch.mock.calls.find(([url, opts]) => url.endsWith('/queue') && opts?.method === 'POST')
    expect(del && JSON.parse(del[1]?.body ?? '{}')).toEqual({ delete: ['p-half'] })
  })

  it('a full rejection (400) still reads the same', async () => {
    answer({ status: 400, body: { error: { message: 'Prompt outputs failed validation' }, node_errors: saveVideoError } })
    await expect(submitWorkflow(graph, 'lu-test')).rejects.toThrow(
      "ComfyUI rejected workflow: Prompt outputs failed validation | Node 75 (SaveVideo): Value not in list (vae_name: 'ltx-2.5-video-vae-bf16.safetensors')",
    )
  })

  it('an empty node_errors is a normal start', async () => {
    answer({ status: 200, body: { prompt_id: 'p-ok', number: 4, node_errors: {} } })
    await expect(submitWorkflow(graph, 'lu-test')).resolves.toBe('p-ok')
    expect(localFetch.mock.calls.some(([url]) => url.endsWith('/queue'))).toBe(false)
  })
})
