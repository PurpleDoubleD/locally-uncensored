// @vitest-environment jsdom
/**
 * B38 and B45 on the Stage: the end image slot of Animate and the reference
 * images of the Image tab show where the model on screen reads them. Where
 * it does not, a line says so and names the models that do, and an image
 * kept from an earlier model is marked "not sent".
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/end-image-and-image-references-show-where-they-work.test.tsx
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

// The Animate pick is the stored one here (the real resolution, which needs
// the whole catalogue, is createRunModel's own tests).
vi.mock('../../../../lib/render/create-studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/render/create-studio')>()
  return { ...actual, createRunModel: (_: string, p: { video: string }) => p.video }
})
import { EndImageSlot, ImageReferenceStrip, cloudEndFrameHint } from '../FrameRefs'
import { ReferenceStrip } from '../ReferenceStrip'
import { useCreateStore } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'

const PIC = { filename: 'p.png', url: 'data:image/png;base64,p', width: 8, height: 8 }
const A14B = 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'
const TI2V = 'wan2.2_ti2v_5B_fp16.safetensors'
const REF2VA = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'

function animateWith(model: string, type: string) {
  useCreateStore.setState({ backend: 'local', videoModel: model, videoModelList: [{ name: model, type }] as never, endImage: null, references: [] })
  useCreateStore.getState().setIntent('animate')
  useCreateStore.getState().setSource(PIC)
}
function imageWith(model: string, type: string) {
  useCreateStore.setState({ backend: 'local', imageModel: model, imageModelList: [{ name: model, type }] as never, imageReferences: [] })
  useCreateStore.getState().setIntent('image')
}

beforeEach(() => cleanup())

describe('Animate: end image', () => {
  it('offered for Wan 2.2 14B i2v', () => {
    animateWith(A14B, 'wan')
    render(<EndImageSlot />)
    expect(screen.getByTestId('end-image-add')).toBeTruthy()
    expect(screen.getByTestId('end-image-line').textContent).toContain('the picture the clip should end on')
  })
  it('the TI2V-5B says it starts from one image and which models take an end image', () => {
    animateWith(TI2V, 'wan22')
    render(<EndImageSlot />)
    expect(screen.queryByTestId('end-image-add')).toBeNull()
    expect(screen.getByTestId('end-image-unsupported').textContent).toContain('Wan 2.2 14B i2v')
  })
  it('an end image kept from another model is marked not sent', () => {
    animateWith(TI2V, 'wan22')
    useCreateStore.setState({ endImage: PIC })
    render(<EndImageSlot />)
    expect(screen.getByTestId('end-image-slot').querySelector('[data-not-sent="true"]')).toBeTruthy()
    expect(screen.getByTestId('end-image-line').textContent).toContain('not sent')
  })
  // W6-API (30.10.2026): the server's catalogue marks the models that take an
  // end image. Without the field (a server from before W6) none is offered.
  it('LU Cloud: a model the catalogue marks takes one, the others name those', () => {
    useCloudCatalogStore.setState({ models: neuerServer().map((m) => (m.id === 'seedance-2.5-spicy' || m.id === 'wan-3.0' ? { ...m, end_image: true } : m)) })
    animateWith(A14B, 'wan')
    useCreateStore.setState({ backend: 'cloud', cloudVideoModel: 'seedance-2.5-spicy' })
    render(<EndImageSlot />)
    expect(screen.getByTestId('end-image-add')).toBeTruthy()
    cleanup()
    useCreateStore.setState({ cloudVideoModel: 'wan-2.2-fast' })
    render(<EndImageSlot />)
    const line = screen.getByTestId('end-image-unsupported').textContent ?? ''
    expect(line).toContain('These also end on your image:')
    expect(line).toContain('Seedance 2.5 Uncensored')
  })
  it('the line names three models and counts the rest', () => {
    const m = (label: string) => ({ label, end_image: true })
    expect(cloudEndFrameHint([m('A'), m('B')])).toBe('This model starts from one image. These also end on your image: A, B.')
    expect(cloudEndFrameHint([m('A'), m('B'), m('C'), m('D'), m('E'), { label: 'F' }])).toBe('This model starts from one image. These also end on your image: A, B, C and 2 more.')
  })
  it('LU Cloud before W6: no model offers one, the line says where it works', () => {
    useCloudCatalogStore.setState({ models: neuerServer() })
    animateWith(A14B, 'wan')
    useCreateStore.setState({ backend: 'cloud', cloudVideoModel: 'seedance-2.5-spicy' })
    render(<EndImageSlot />)
    expect(screen.queryByTestId('end-image-add')).toBeNull()
    expect(screen.getByTestId('end-image-unsupported').textContent).toContain('The LU Cloud video models here start from one image.')
  })
  it('a removed start image takes the end image with it', () => {
    animateWith(A14B, 'wan')
    useCreateStore.setState({ endImage: PIC })
    useCreateStore.getState().setSource(null)
    expect(useCreateStore.getState().endImage).toBeNull()
  })
})

describe('Animate: several references with MiniMax H3 ref2va', () => {
  it('the reference strip opens with eight more slots', () => {
    animateWith(REF2VA, 'minimaxh3')
    render(<ReferenceStrip />)
    expect(screen.getByTestId('reference-strip-names').textContent).toContain('Add up to 8 more images')
  })
})

describe('Image tab: reference images', () => {
  it('Krea 2 says it takes the style, not pose or angle', () => {
    imageWith('krea2_turbo_int8_convrot.safetensors', 'krea2')
    render(<ImageReferenceStrip />)
    expect(screen.getByTestId('image-reference-add')).toBeTruthy()
    expect(screen.getByTestId('image-references-line').textContent).toMatch(/style.*not the pose or camera angle/)
  })
  it('Qwen-Image 2.1 offers ten', () => {
    imageWith('qwen_image_2.1_int8_convrot.safetensors', 'qwenimage')
    useCreateStore.setState({ imageReferences: Array.from({ length: 9 }, () => PIC) })
    render(<ImageReferenceStrip />)
    expect(screen.getByTestId('image-reference-add')).toBeTruthy()
    cleanup()
    useCreateStore.setState({ imageReferences: Array.from({ length: 10 }, () => PIC) })
    render(<ImageReferenceStrip />)
    expect(screen.queryByTestId('image-reference-add')).toBeNull()
  })
  it('SDXL: the honest line, and kept images are marked not sent', () => {
    imageWith('juggernautXL_v9.safetensors', 'sdxl')
    render(<ImageReferenceStrip />)
    expect(screen.getByTestId('image-references-unsupported')).toBeTruthy()
    cleanup()
    useCreateStore.setState({ imageReferences: [PIC] })
    render(<ImageReferenceStrip />)
    expect(screen.getByTestId('image-references').querySelector('[data-not-sent="true"]')).toBeTruthy()
    expect(screen.getByTestId('image-references-line').textContent).toContain('Krea 2 (style), Qwen-Image 2.1 and FLUX.2')
  })
  it('LU Cloud points to Edit', () => {
    imageWith('krea2_turbo_int8_convrot.safetensors', 'krea2')
    useCreateStore.setState({ backend: 'cloud', imageReferences: [PIC] })
    render(<ImageReferenceStrip />)
    expect(screen.getByTestId('image-references-line').textContent).toContain('use Edit')
  })
})
