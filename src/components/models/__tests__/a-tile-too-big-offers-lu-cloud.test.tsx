// @vitest-environment jsdom
/**
 * 3.0.7, the owner's wish of 15.10.2026: a model in the Model Manager that does
 * not fit this machine says there that LU Cloud runs the task, with one
 * button into the cloud. Only on such a tile, never in cloud mode, never with
 * "Show Cloud features in Local mode" off, a number of credits only where the
 * app knows the price, and the click goes the way the model picker's LU Cloud
 * rows go: the cloud gate, with Create on the same tab for a media model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { BundleTile, ModelTile } from '../ModelTiles'
import { ClassicBundleTile, ClassicModelTile } from '../skin/ClassicTiles'
import { MacMediaTile } from '../MacMediaTile'
import { getImageBundles, getVideoBundles } from '../../../api/model-bundles'
import type { DiscoverModel } from '../../../api/discover'
import type { CloudOfferTask } from '../../../lib/cloud-offer'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useUIStore } from '../../../stores/uiStore'
import { useCreateStore } from '../../../stores/createStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { CLOUD_MODEL_SEED } from '../../../lib/render/cloud-models'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

const noop = () => {}
const bundle = (name: string) => [...getImageBundles(), ...getVideoBundles()].find((b) => b.name === name)!

const QUOTA: CloudQuota = {
  tier: 'hosted', period: '2026-10', limits: { credits: 100_000 }, costs: { image: 500, video: 9000 },
  used: { credits_used: 0 }, remaining: { credits: 100_000 },
}

function bundleTile(name: string, vramGb: number, opts: { classic?: boolean; complete?: boolean; task?: CloudOfferTask } = {}) {
  const Tile = opts.classic ? ClassicBundleTile : BundleTile
  return render(
    <Tile
      bundle={bundle(name)} vramGb={vramGb} cloudTask={opts.task ?? 'image'}
      complete={opts.complete ?? false} downloading={false} hasErrors={false}
      onInstall={noop} onRetry={noop} onClear={noop} onOpenUrl={noop}
    />,
  )
}

const bigChat: DiscoverModel = { name: 'Huge 120B Q4', description: 'big', pulls: '', tags: [], updated: '', sizeGB: 70, downloadUrl: 'x', filename: 'huge.gguf' }
function chatTile(vramGb: number, opts: { classic?: boolean; sharedMemory?: boolean; installed?: boolean } = {}) {
  const Tile = opts.classic ? ClassicModelTile : ModelTile
  return render(
    <Tile
      variants={[bigChat]} vramGb={vramGb} sharedMemory={opts.sharedMemory}
      isInstalled={() => opts.installed ?? false} dlState={() => null}
      onDownload={noop} onInfo={noop} onOpenUrl={noop}
    />,
  )
}

const offer = () => screen.queryByTestId('cloud-offer-tile')

beforeEach(() => {
  useSettingsStore.getState().updateSettings({ appMode: 'local', cloudTeasersEnabled: true })
  useUIStore.setState({ cloudGateOpen: false, pendingCloudModel: 'left-over', currentView: 'models' })
  useCreateStore.setState({ backend: 'local' })
  useCreateStore.getState().setIntent('image')
  useCloudAuthStore.setState({ user: null, licenseActive: false, access: false, quota: null })
  useCloudCatalogStore.setState({ fetchedAt: null, models: CLOUD_MODEL_SEED })
})
afterEach(cleanup)

describe('where the line shows', () => {
  it('a bundle too big for the card names the task and LU Cloud, on both faces', () => {
    for (const classic of [false, true]) {
      bundleTile('ERNIE-Image Turbo', 12, { classic })
      expect(offer()?.textContent).toContain('Too big for this graphics card. Images run on LU Cloud.')
      expect(screen.getByTestId('cloud-offer-button').textContent).toBe('Try LU Cloud')
      cleanup()
    }
  })

  it('not on a bundle that fits or sits tight', () => {
    bundleTile('Juggernaut XL V9 (Photorealistic)', 12)
    expect(offer()).toBeNull()
    cleanup()
    bundleTile('Z-Image Turbo (Unfiltered, Fast)', 12)
    expect(offer()).toBeNull()
  })

  it('never on an add-on: its model\'s tile speaks for it', () => {
    // No add-on in the catalogue is above 12 GB any more (the H3 turbo LoRA
    // was), so a real one is given that need.
    const found = [...getImageBundles(), ...getVideoBundles()].find((b) => b.addonFor && b.vramMinGB)
    expect(found, 'an add-on with a number').toBeDefined()
    const addon = { ...found!, vramMinGB: 24, vramComfortGB: 24 }
    render(
      <BundleTile
        bundle={addon} vramGb={12} cloudTask="video"
        complete={false} downloading={false} hasErrors={false}
        onInstall={noop} onRetry={noop} onClear={noop} onOpenUrl={noop}
      />,
    )
    expect(offer()).toBeNull()
  })

  it('not on a bundle that is already here', () => {
    bundleTile('ERNIE-Image Turbo', 12, { complete: true })
    expect(offer()).toBeNull()
  })

  it('a chat model too big for the card leads to the cloud chat models, on both faces', () => {
    for (const classic of [false, true]) {
      chatTile(12, { classic })
      expect(offer()?.textContent).toContain('Too big for this graphics card. Large chat models run on LU Cloud.')
      expect(offer()?.getAttribute('data-cloud-task')).toBe('chat')
      cleanup()
    }
  })

  it('not on a chat model that fits, or one that is installed', () => {
    chatTile(96)
    expect(offer()).toBeNull()
    cleanup()
    chatTile(12, { installed: true })
    expect(offer()).toBeNull()
  })

  it('a Mac speaks of its memory', () => {
    chatTile(12, { sharedMemory: true })
    expect(offer()?.textContent).toContain("Too big for this Mac's memory.")
    expect(offer()?.textContent).not.toMatch(/graphics card|GPU/)
  })

  it('a Mac media model above this Mac\'s memory, and not one that fits', () => {
    const model = { id: 'big', name: 'Big Video', repo: 'a/b', sizeBytes: 20e9, minRamGB: 64, unfiltered: false, description: 'x' }
    render(<MacMediaTile model={model} memoryGb={16} state={{ kind: 'idle' }} onGet={noop} onCancel={noop} onRemove={noop} onOpenUrl={noop} cloudTask="video" />)
    expect(offer()?.textContent).toContain("Too big for this Mac's memory. Videos run on LU Cloud.")
    cleanup()
    render(<MacMediaTile model={model} memoryGb={128} state={{ kind: 'idle' }} onGet={noop} onCancel={noop} onRemove={noop} onOpenUrl={noop} cloudTask="video" />)
    expect(offer()).toBeNull()
  })

  it('never in cloud mode', () => {
    useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
    bundleTile('ERNIE-Image Turbo', 12)
    expect(offer()).toBeNull()
  })

  it('never with "Show Cloud features in Local mode" off', () => {
    useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: false })
    chatTile(12)
    expect(offer()).toBeNull()
  })
})

describe('the price', () => {
  it('no number without an account, so no guessed figure', () => {
    bundleTile('ERNIE-Image Turbo', 12, { task: 'video' })
    expect(screen.queryByTestId('cloud-offer-credits')).toBeNull()
    expect(offer()?.textContent).not.toMatch(/credits|€|EUR/)
  })

  it('no number from the built-in list, only from a catalogue the server sent', () => {
    useCloudAuthStore.setState({ quota: QUOTA })
    useCreateStore.setState({ cloudVideoModel: 'ltx-2', cloudFrames: 97, cloudFps: 24 })
    bundleTile('ERNIE-Image Turbo', 12, { task: 'video' })
    expect(screen.queryByTestId('cloud-offer-credits')).toBeNull()
  })

  it('the catalogue figure Create would book, once it is known', () => {
    useCloudAuthStore.setState({ quota: QUOTA })
    useCloudCatalogStore.setState({ fetchedAt: Date.now() })
    useCreateStore.setState({ cloudVideoModel: 'ltx-2', cloudFrames: 97, cloudFps: 24 })
    bundleTile('ERNIE-Image Turbo', 12, { task: 'video' })
    expect(screen.getByTestId('cloud-offer-credits').textContent).toBe(' About 8,000 credits per run.')
  })

  it('a model without a catalogue price shows no 0 and no stand-in figure', () => {
    useCloudAuthStore.setState({ quota: QUOTA })
    useCloudCatalogStore.setState({
      fetchedAt: Date.now(),
      models: CLOUD_MODEL_SEED.map((m) => (m.id === 'ltx-2' ? { ...m, credits: undefined } : m)),
    })
    useCreateStore.setState({ cloudVideoModel: 'ltx-2', cloudFrames: 97, cloudFps: 24 })
    bundleTile('ERNIE-Image Turbo', 12, { task: 'video' })
    expect(screen.queryByTestId('cloud-offer-credits')).toBeNull()
    expect(offer()?.textContent).not.toMatch(/\b0 credits|9,000/)
  })

  it('a chat model never names a number', () => {
    useCloudAuthStore.setState({ quota: QUOTA })
    useCloudCatalogStore.setState({ fetchedAt: Date.now() })
    chatTile(12)
    expect(screen.queryByTestId('cloud-offer-credits')).toBeNull()
  })
})

describe('the click', () => {
  it('a media model: Create on the same tab, and the cloud gate with the plans', () => {
    bundleTile('ERNIE-Image Turbo', 12, { task: 'animate' })
    fireEvent.click(screen.getByTestId('cloud-offer-button'))
    expect(useCreateStore.getState().intent()).toBe('animate')
    expect(useUIStore.getState().cloudGateOpen).toBe(true)
    // Without an account that can use the cloud now, the plans open over the
    // page the user is on: no move away from it.
    expect(useUIStore.getState().currentView).toBe('models')
  })

  it('an account that can use the cloud goes to Create, where the gate switches it over', () => {
    useCloudAuthStore.setState({ user: { id: 'u' } as never, licenseActive: true, access: true, quota: QUOTA })
    bundleTile('ERNIE-Image Turbo', 12, { task: 'video' })
    fireEvent.click(screen.getByTestId('cloud-offer-button'))
    expect(useCreateStore.getState().intent()).toBe('video')
    expect(useUIStore.getState().currentView).toBe('create')
    expect(useUIStore.getState().cloudGateOpen).toBe(true)
  })

  it('a chat model: the gate with no model named, Create untouched', () => {
    chatTile(12)
    fireEvent.click(screen.getByTestId('cloud-offer-button'))
    expect(useUIStore.getState().cloudGateOpen).toBe(true)
    expect(useUIStore.getState().pendingCloudModel).toBeNull()
    expect(useCreateStore.getState().intent()).toBe('image')
    expect(useUIStore.getState().currentView).toBe('models')
  })
})
