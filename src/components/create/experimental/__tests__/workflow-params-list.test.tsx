// @vitest-environment jsdom
/**
 * GitHub wish #8 on screen: the "Workflow parameters" list under the advanced
 * settings of Create, for an imported workflow. Controls by type, a change is
 * stored per workflow, Reset goes back to the file, what LU sets is not a
 * second control, and the search finds a setting by name.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import wfJson from '../../../../api/__tests__/fixtures/workflow-params/sdxl-lora-vae.api.json'
import objectInfo from '../../../../api/__tests__/fixtures/comfy-ui/object-info.json'
import type { ComfyApiGraph } from '../../../../types/comfy-graph'
import type { WorkflowTemplate } from '../../../../types/workflows'

// The recorded /object_info plus one custom node with a switch, a list in the
// newer COMBO shape and a long text.
const defs = {
  ...objectInfo,
  LU_TestToggle: {
    input: {
      required: { enabled: ['BOOLEAN', { default: true }], mode: ['COMBO', { options: ['fast', 'slow'] }] },
      optional: { note: ['STRING', { multiline: true }] },
    },
  },
}
const loadNodeDefs = vi.fn(async (_types: string[]): Promise<unknown> => defs)
vi.mock('../../../../api/workflow-import', () => ({ loadNodeDefs: (t: string[]) => loadNodeDefs(t) }))

const { useWorkflowStore } = await import('../../../../stores/workflowStore')
const { autoDetectParameterMap } = await import('../../../../api/workflows')
const { WorkflowParams, ActiveWorkflowParams, __clearWorkflowParamDefsForTests } = await import('../WorkflowParams')

const graph = JSON.parse(JSON.stringify(wfJson)) as ComfyApiGraph
const template: WorkflowTemplate = {
  id: 'wf-1', name: 'My SDXL', description: '', source: 'manual', modelTypes: ['sdxl'], mode: 'image',
  workflow: graph, parameterMap: autoDetectParameterMap(graph), installedAt: 1,
}

beforeEach(() => {
  __clearWorkflowParamDefsForTests()
  loadNodeDefs.mockClear()
  useWorkflowStore.setState({ installedWorkflows: [template], paramOverrides: {}, modelNameAssignments: {}, modelTypeAssignments: {}, modelTags: {}, workflowTags: {} })
})
afterEach(() => cleanup())

async function renderList() {
  render(createElement(WorkflowParams, { workflow: template }))
  await waitFor(() => expect(loadNodeDefs).toHaveBeenCalled())
  // The definitions are in once the LoRA list has its choices.
  fireEvent.click(screen.getByRole('button', { name: /Detail LoRA/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Lora name' }).getAttribute('aria-haspopup')).toBe('listbox'))
}

/** C79: a list is LU's own picker now. Open it and click the row. */
function pick(name: string, row: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: row }))
}

function node(name: RegExp) {
  return screen.getByRole('button', { name }).closest('li') as HTMLElement
}

describe('Workflow parameters in Create', () => {
  it('lists the nodes folded, with a control that fits each value', async () => {
    await renderList()
    expect(screen.getByText('Workflow parameters')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sampler/ }).getAttribute('aria-expanded')).toBe('false')
    const lora = node(/Detail LoRA/)
    expect(within(lora).getByRole('button', { name: 'Lora name' }).textContent).toBe('detail_tweaker_xl.safetensors')
    const strength = within(lora).getByLabelText('Strength model') as HTMLInputElement
    expect(strength.type).toBe('number')
    expect(strength.min).toBe('-100')
    expect(strength.step).toBe('0.01')
    fireEvent.click(screen.getByRole('button', { name: /LU_TestToggle/ }))
    expect((screen.getByLabelText('Enabled') as HTMLInputElement).type).toBe('checkbox')
    expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA')
    expect(screen.getByRole('button', { name: 'Mode' }).getAttribute('aria-haspopup')).toBe('listbox')
  })

  it('stores a change for this workflow, shows it, and Reset goes back to the file', async () => {
    await renderList()
    fireEvent.change(screen.getByLabelText('Strength model'), { target: { value: '0.4' } })
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toEqual({ '10': { strength_model: 0.4 } })
    expect(screen.getAllByText('1 changed').length).toBeGreaterThan(0)

    // Typing the file value again is no change at all.
    fireEvent.change(screen.getByLabelText('Strength model'), { target: { value: '0.8' } })
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toBeUndefined()

    pick('Lora name', 'detail_tweaker_xl.safetensors')
    fireEvent.change(screen.getByLabelText('Strength clip'), { target: { value: '2' } })
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toEqual({ '10': { strength_clip: 2 } })
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }))
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toBeUndefined()
    expect((screen.getByLabelText('Strength clip') as HTMLInputElement).value).toBe('1')
  })

  it('does not offer what LU sets itself, and says so', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: /Sampler/ }))
    const sampler = node(/Sampler/)
    expect(within(sampler).getByText('Set by LU: Seed, Steps, CFG, Sampler, Scheduler')).toBeTruthy()
    expect(within(sampler).queryByLabelText('Steps')).toBeNull()
    expect(within(sampler).queryByLabelText('Cfg')).toBeNull()
    expect(within(sampler).getByLabelText('Denoise')).toBeTruthy()
  })

  it('offers the VAE with Auto first, and a pick is stored', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: /VAELoader/ }))
    expect(screen.getByRole('button', { name: 'Vae name' }).textContent).toBe('Auto (LU picks a match)')
    fireEvent.click(screen.getByRole('button', { name: 'Vae name' }))
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[0].textContent).toBe('Auto (LU picks a match)')
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'ae.safetensors' }))
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toEqual({ '12': { vae_name: 'ae.safetensors' } })
    pick('Vae name', 'Auto (LU picks a match)')
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toBeUndefined()
  })

  it('finds a setting by name and opens its node', async () => {
    await renderList()
    fireEvent.change(screen.getByLabelText('Search workflow parameters'), { target: { value: 'clip layer' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect((screen.getByLabelText('Stop at clip layer') as HTMLInputElement).value).toBe('-2')
    fireEvent.change(screen.getByLabelText('Search workflow parameters'), { target: { value: 'nothing like this' } })
    expect(screen.getByText('No parameter matches this search.')).toBeTruthy()
  })

  it('still works when ComfyUI does not answer, and says what is missing', async () => {
    loadNodeDefs.mockResolvedValueOnce(null)
    render(createElement(WorkflowParams, { workflow: template }))
    expect(await screen.findByText(/ComfyUI is not answering/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Detail LoRA/ }))
    expect((screen.getByLabelText('Lora name') as HTMLInputElement).type).toBe('text')
  })

  it('is only drawn for a workflow from the workflow manager that Create will use', async () => {
    const { container, rerender } = render(createElement(ActiveWorkflowParams, { modelName: 'mine.safetensors', modelType: 'sdxl' }))
    expect(container.innerHTML).toBe('')
    useWorkflowStore.setState({ modelNameAssignments: { 'mine.safetensors': 'wf-1' } })
    rerender(createElement(ActiveWorkflowParams, { modelName: 'mine.safetensors', modelType: 'sdxl' }))
    expect(await screen.findByText('Workflow parameters')).toBeTruthy()
  })

  it('C79: a long LoRA list has a search, and a pick from it is stored', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `style_${String(i).padStart(2, '0')}.safetensors`)
    loadNodeDefs.mockResolvedValueOnce({
      ...defs,
      LoraLoader: { input: { required: { ...defs.LoraLoader.input.required, lora_name: [['detail_tweaker_xl.safetensors', 'pixel-art-xl.safetensors', ...many]] } } },
    })
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Lora name' }))
    const search = screen.getByRole('textbox', { name: 'Search Lora name' })
    fireEvent.change(search, { target: { value: 'pixel' } })
    const rows = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(rows.map((r) => r.textContent)).toEqual(['pixel-art-xl.safetensors'])
    fireEvent.click(rows[0])
    expect(useWorkflowStore.getState().paramOverrides['wf-1']).toEqual({ '10': { lora_name: 'pixel-art-xl.safetensors' } })
  })

  it('C79: a short list has no search field', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Lora name' }))
    expect(screen.queryByRole('textbox', { name: 'Search Lora name' })).toBeNull()
  })

  it('C72: a workflow whose loader does not fit the model says so before the run', async () => {
    const { useCreateStore } = await import('../../../../stores/createStore')
    useWorkflowStore.setState({ modelNameAssignments: { 'flux1-dev.safetensors': 'wf-1' } })
    // The checkpoint workflow, assigned to a model from diffusion_models.
    useCreateStore.setState({ imageModelList: [{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }] as never })
    render(createElement(ActiveWorkflowParams, { modelName: 'flux1-dev.safetensors', modelType: 'flux' }))
    const note = await screen.findByTestId('own-workflow-misfit')
    expect(note.textContent).toContain('Your workflow "My SDXL" is not used: this model is a diffusion model and needs a UNETLoader')
    expect(note.textContent).toContain('LU builds its own workflow for this model instead.')
  })

  it('C72: a fitting workflow shows no such line', async () => {
    const { useCreateStore } = await import('../../../../stores/createStore')
    useWorkflowStore.setState({ modelNameAssignments: { 'mine.safetensors': 'wf-1' } })
    useCreateStore.setState({ imageModelList: [{ name: 'mine.safetensors', type: 'sdxl', source: 'checkpoint' }] as never })
    render(createElement(ActiveWorkflowParams, { modelName: 'mine.safetensors', modelType: 'sdxl' }))
    expect(await screen.findByText('Workflow parameters')).toBeTruthy()
    expect(screen.queryByTestId('own-workflow-misfit')).toBeNull()
  })
})
