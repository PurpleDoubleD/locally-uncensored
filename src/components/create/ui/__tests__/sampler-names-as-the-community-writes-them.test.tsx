// @vitest-environment jsdom
/**
 * C24, Discord xlollobx 31.10.2026: "the names look a bit different in the
 * list". Community tips say "DPM++ SDE" and "Euler a", Create listed ComfyUI's
 * dpmpp_sde and euler_ancestral. The list shows the readable name now, keeps
 * the raw one small beside it and as the tooltip, finds either spelling, and
 * still stores and sends the raw name.
 *
 * Run: npx vitest run src/components/create/ui/__tests__/sampler-names-as-the-community-writes-them.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../Select'
import { samplerLabel, samplerOptions, schedulerLabel, schedulerOptions, workflowOptionText } from '../../../../lib/sampler-names'

afterEach(cleanup)

// What a current ComfyUI reports for KSampler, plus one from a custom node.
const COMFY_SAMPLERS = [
  'euler', 'euler_cfg_pp', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms',
  'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde',
  'dpmpp_2m_sde_gpu', 'dpmpp_3m_sde', 'lcm', 'ddim', 'uni_pc', 'my_custom_sampler',
]

describe('the readable name', () => {
  it('is the one community tips use', () => {
    expect(samplerLabel('dpmpp_sde')).toBe('DPM++ SDE')
    expect(samplerLabel('dpmpp_2m_sde')).toBe('DPM++ 2M SDE')
    expect(samplerLabel('euler_ancestral')).toBe('Euler a')
    expect(samplerLabel('dpmpp_2s_ancestral')).toBe('DPM++ 2S a')
    expect(samplerLabel('uni_pc')).toBe('UniPC')
    expect(schedulerLabel('karras')).toBe('Karras')
    expect(schedulerLabel('sgm_uniform')).toBe('SGM Uniform')
  })

  it("names ComfyUI's variants after their sampler", () => {
    expect(samplerLabel('dpmpp_2m_sde_gpu')).toBe('DPM++ 2M SDE GPU')
    expect(samplerLabel('euler_cfg_pp')).toBe('Euler CFG++')
  })

  it('falls back to the raw name for a name it does not know', () => {
    expect(samplerLabel('my_custom_sampler')).toBe('my_custom_sampler')
    expect(samplerLabel('foo_gpu')).toBe('foo_gpu')
    expect(schedulerLabel('my_schedule')).toBe('my_schedule')
    // An unknown name is not shown twice.
    expect(samplerOptions(['my_custom_sampler'])).toEqual([{ value: 'my_custom_sampler', label: 'my_custom_sampler' }])
  })

  it('keeps the raw name as the value, beside the row and as the tooltip', () => {
    expect(samplerOptions(['dpmpp_sde'])).toEqual([
      { value: 'dpmpp_sde', label: 'DPM++ SDE', sublabel: 'dpmpp_sde', title: 'dpmpp_sde' },
    ])
    expect(schedulerOptions(['karras'])[0]).toMatchObject({ value: 'karras', label: 'Karras', sublabel: 'karras' })
  })
})

describe('the sampler picker', () => {
  const names = () => screen.queryAllByRole('option').map((o) => o.querySelector('.lu-picker-name')?.textContent)

  function open(onChange = vi.fn()) {
    render(<Select ariaLabel="Sampler" searchable options={samplerOptions(COMFY_SAMPLERS)} value="dpmpp_2m_sde" onChange={onChange} />)
    // The closed field shows the readable name, the raw one is its tooltip.
    const trigger = screen.getByRole('button', { name: 'Sampler' })
    expect(trigger.textContent).toBe('DPM++ 2M SDE')
    expect(trigger.querySelector('[title]')?.getAttribute('title')).toBe('dpmpp_2m_sde')
    fireEvent.click(trigger)
    return screen.getByPlaceholderText('Search...')
  }
  const search = (box: HTMLElement, q: string) => fireEvent.change(box, { target: { value: q } })

  it('finds a sampler by the name from a tip', () => {
    const box = open()
    search(box, 'DPM++ SDE')
    expect(names()).toEqual(['DPM++ SDE', 'DPM++ SDE GPU'])
    search(box, 'euler a')
    expect(names()).toEqual(['Euler a'])
  })

  it('finds it by the raw ComfyUI name, written either way', () => {
    const box = open()
    search(box, 'dpmpp_2m_sde')
    expect(names()).toEqual(['DPM++ 2M SDE', 'DPM++ 2M SDE GPU'])
    search(box, 'euler_a')
    expect(names()).toEqual(['Euler a'])
    search(box, 'dpmpp sde')
    expect(names()).toEqual(['DPM++ SDE', 'DPM++ SDE GPU'])
  })

  it('shows the raw name small in the row and stores it on pick', () => {
    const onChange = vi.fn()
    const box = open(onChange)
    search(box, 'DPM++ SDE')
    const row = screen.getAllByRole('option')[0]
    expect(row.querySelector('.lu-picker-sub')?.textContent).toBe('dpmpp_sde')
    fireEvent.click(row)
    expect(onChange).toHaveBeenCalledWith('dpmpp_sde')
  })

  it('lists an unknown sampler under its raw name', () => {
    const box = open()
    search(box, 'custom')
    expect(names()).toEqual(['my_custom_sampler'])
  })
})

describe('the Workflow parameters list of an imported workflow', () => {
  it('names a sampler or scheduler both ways, other inputs as they are', () => {
    expect(workflowOptionText('sampler_name', 'dpmpp_2m_sde')).toBe('DPM++ 2M SDE · dpmpp_2m_sde')
    expect(workflowOptionText('scheduler', 'karras')).toBe('Karras · karras')
    expect(workflowOptionText('sampler_name', 'my_custom_sampler')).toBe('my_custom_sampler')
    // A "karras" in some other input is not a scheduler.
    expect(workflowOptionText('mode', 'karras')).toBe('karras')
  })
})
