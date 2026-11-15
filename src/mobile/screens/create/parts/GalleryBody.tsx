/**
 * K6 Gallery, the body of its two pages: /create/gallery (GalleryPage) and
 * /create/gallery/pick/:purpose (GalleryPickPage), the gallery as a picker
 * for a source image, a clip to extend or a voice. Strand 3 (Create).
 *
 * Filter chips All, Images, Video, Audio. A grid with three columns from
 * 320 pt on. K6.1 filter chip, K6.2 tile (opens K7), K6.3 Select (several
 * tiles, then Delete and Save), K6.4 Use in the picker (hands the tile back
 * to whoever asked: source image, clip to extend, voice).
 * States: empty, an address that expired is signed again ("Refreshing"),
 * a result that is gone for good shows "Expired" with "Remove".
 * 200 entries scroll smoothly: tiles far away are neither laid out nor
 * loaded (content-visibility and an observer).
 */
import { memo, useMemo, useRef, useState } from 'react'
import { AudioLines, Box, Check, ListChecks, Play, X } from 'lucide-react'
import { ModelThumb } from '../../../../components/three/ModelThumb'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { nav } from '../../../nav'
import { COMPUTER_STRINGS as C, CREATE_STRINGS as T } from '../../../strings/create'
import { Button, Chip, ChipGroup, EmptyState, Icon, IconButton, Page, Segmented, toast } from '../../../ui'
import { ComputerGallery } from './ComputerGallery'
import { useComputerAvailability } from './computer-source'
import { deleteItems, saveWithToast, takeItemAsExtend, takeItemAsSource, takeItemAsVoice } from './actions'
import { saveItem } from './media-out'
import { toolTakesPhoto } from './tools'
import { MediaStateBox, itemName, useItemMedia, useNearViewport } from './ui'

type Filter = 'all' | 'image' | 'video' | 'audio' | '3d'
import type { PickPurpose } from './pick'

type Purpose = PickPurpose

const PURPOSE_KIND: Record<Purpose, GalleryItem['type']> = { source: 'image', extend: 'video', voice: 'audio' }

interface TileProps {
  item: GalleryItem
  selecting: boolean
  selected: boolean
  onPress: (id: string) => void
}

const Tile = memo(function Tile({ item, selecting, selected, onPress }: TileProps) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearViewport(ref)
  const media = useItemMedia(item)
  const name = itemName(item)
  const state = media.state
  const showMedia = near && state === 'ok' && media.url
  return (
    <div ref={ref} className="m-k-tile" data-selected={selected ? '' : undefined} data-testid="m-create-gallery-tile" data-m-id={item.id} data-m-kind={item.type} data-state={state}>
      <button
        type="button"
        className="m-k-tile-main"
        aria-label={selecting ? T.gal.pick(name) : T.gal.open(name)}
        aria-pressed={selecting ? selected : undefined}
        data-testid="m-create-gallery-item"
        data-m-id={item.id}
        data-el="K6.2"
        onClick={() => onPress(item.id)}
      >
        {showMedia && item.type === 'image' ? <img src={media.url ?? undefined} alt="" loading="lazy" decoding="async" onError={media.onError} /> : null}
        {showMedia && item.type === 'video' ? <video src={`${media.url}#t=0.1`} muted playsInline preload="metadata" onError={media.onError} /> : null}
        {item.type === 'audio' && state === 'ok' ? <Icon icon={AudioLines} /> : null}
        {/* A 3D model shows the still the 3D view drew of it, or the cube with its name. */}
        {near && item.type === '3d' && state === 'ok' ? <ModelThumb item={item} small /> : null}
        {state !== 'ok' ? <MediaStateBox state={state} compact /> : null}
      </button>
      {item.type !== 'image' && state === 'ok' ? (
        <span className="m-k-tile-badge">
          {item.type === 'video' ? <Play /> : item.type === '3d' ? <Box /> : <AudioLines />}
          {T.gal.kind[item.type]}
        </span>
      ) : null}
      {selecting ? (
        <span className="m-k-tile-check" aria-hidden="true">
          {selected ? <Check /> : null}
        </span>
      ) : null}
      {state === 'expired' && !selecting ? (
        <button type="button" className="m-k-tile-remove" data-testid="m-create-gallery-remove" data-m-id={item.id} onClick={() => deleteItems([item.id])}>
          {T.gal.remove}
        </button>
      ) : null}
    </div>
  )
})

/** `purpose` null is the gallery itself, a purpose makes it the picker for that purpose. */
export function GalleryBody({ purpose }: { purpose: Purpose | null }) {
  const gallery = useCreateStore((s) => s.gallery)
  const [filter, setFilter] = useState<Filter>('all')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // A17: the gallery of the computer, as a second tab, when the computer shows it to this phone.
  const computerGallery = useComputerAvailability().gallery && purpose === null
  const [where, setWhere] = useState<'phone' | 'computer'>('phone')
  const onComputer = computerGallery && where === 'computer'

  const kind = purpose ? PURPOSE_KIND[purpose] : filter === 'all' ? null : filter
  const has3d = gallery.some((g) => g.type === '3d')
  const items = useMemo(() => {
    const list = kind ? gallery.filter((g) => g.type === kind) : gallery
    // A picker only offers what can be handed over: a cloud result that still exists.
    return purpose ? list.filter((g) => !g.unavailable && (purpose === 'source' || !!g.jobId)) : list
  }, [gallery, kind, purpose])
  const chosen = selected.filter((id) => items.some((g) => g.id === id))
  const picking = purpose !== null
  const selectMode = selecting || picking

  const onPress = (id: string) => {
    if (picking) {
      setSelected([id])
      return
    }
    if (selecting) {
      setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
      return
    }
    nav.push('/create/item/:id', { id })
  }
  const stopSelecting = () => {
    setSelecting(false)
    setSelected([])
  }
  const remove = async () => {
    if (chosen.length === 0) return
    const yes = await nav.confirm({ title: T.gal.deleteTitle(chosen.length), text: T.gal.deleteText, confirmLabel: T.gal.delete, cancelLabel: T.result.keep, tone: 'danger', testid: 'create-gallery-delete' })
    if (!yes) return
    deleteItems(chosen)
    toast(T.gal.deleted(chosen.length), { testid: 'create-deleted' })
    stopSelecting()
  }
  const save = async () => {
    const list = items.filter((g) => chosen.includes(g.id))
    if (list.length === 0) return
    if (list.length === 1) {
      setBusy(T.gal.preparing)
      await saveWithToast(list[0])
      setBusy(null)
      stopSelecting()
      return
    }
    let saved = 0
    let stopped = false
    for (const [i, item] of list.entries()) {
      setBusy(T.gal.saving(i + 1, list.length))
      const out = await saveItem(item)
      if (out.status === 'saved') saved++
      else if (out.status === 'unavailable' || out.status === 'storage' || out.status === 'denied') {
        // The next one would fail the same way: stop and say why, with what was saved so far.
        const why = out.status === 'storage' ? T.saveStorage : out.status === 'denied' ? T.saveDenied : T.saveUnavailable
        toast(saved > 0 ? `${T.savedMany(saved)}. ${why}` : why, { tone: 'error', testid: out.status === 'storage' ? 'create-save-storage' : out.status === 'denied' ? 'create-save-denied' : 'create-save-unavailable' })
        stopped = true
        break
      }
    }
    setBusy(null)
    if (!stopped) toast(saved > 0 ? T.savedMany(saved) : T.saveFailed, { tone: saved > 0 ? 'default' : 'error', testid: 'create-saved' })
    stopSelecting()
  }
  const use = async () => {
    const item = items.find((g) => g.id === chosen[0])
    if (!item || !purpose) return
    setBusy(T.gal.preparing)
    let ok = false
    if (purpose === 'source') {
      const st = useCreateStore.getState()
      const tool = st.intent()
      ok = await takeItemAsSource(item, toolTakesPhoto(tool) ? tool : 'edit')
    } else if (purpose === 'extend') ok = takeItemAsExtend(item)
    else ok = takeItemAsVoice(item)
    setBusy(null)
    if (ok) nav.back()
  }

  const tabs = computerGallery ? (
    <div className="m-k-sec">
      <Segmented
        look="tabs"
        label={C.galleryTabs}
        options={[
          { value: 'phone', label: C.galleryPhone, testid: 'm-create-gallery-tab-phone' },
          { value: 'computer', label: C.galleryComputer, testid: 'm-create-gallery-tab-computer' },
        ]}
        value={onComputer ? 'computer' : 'phone'}
        onChange={(v) => {
          setWhere(v)
          setSelecting(false)
          setSelected([])
        }}
        testid="m-create-gallery-tabs"
      />
    </div>
  ) : null

  if (onComputer) {
    return (
      <Page title={T.gal.title} screen="create-gallery">
        {tabs}
        <ComputerGallery />
      </Page>
    )
  }

  const footer = picking ? (
    <div className="m-k-selbar">
      <Button variant="primary" block busy={busy !== null} disabled={chosen.length === 0} onPress={() => void use()} testid="m-create-gallery-use" el="K6.4">
        {T.gal.use}
      </Button>
    </div>
  ) : selecting ? (
    <div className="m-k-selbar" data-testid="m-create-gallery-selbar">
      <span className="m-cap" aria-live="polite">
        {busy ?? T.gal.selected(chosen.length)}
      </span>
      <Button busy={busy !== null} disabled={chosen.length === 0} onPress={() => void save()} risk="sensor" testid="m-create-gallery-save" el="K6.3">
        {T.gal.save}
      </Button>
      <button type="button" className="m-btn m-btn--danger" disabled={chosen.length === 0 || busy !== null} data-testid="m-create-gallery-delete" data-el="K6.3" data-m-risk="destructive" onClick={() => void remove()}>
        {T.gal.delete}
      </button>
    </div>
  ) : undefined

  return (
    <Page
      title={picking ? T.gal.titlePick : T.gal.title}
      subtitle={T.gal.count(items.length)}
      screen={picking ? 'create-gallery-pick' : 'create-gallery'}
      actions={
        picking || gallery.length === 0 ? null : selecting ? (
          <IconButton icon={X} label={T.gal.done} onPress={stopSelecting} testid="m-create-gallery-select-done" el="K6.3" />
        ) : (
          <IconButton icon={ListChecks} label={T.gal.select} onPress={() => setSelecting(true)} testid="m-create-gallery-select" el="K6.3" />
        )
      }
      footer={footer}
    >
      {tabs}
      {picking ? null : (
        <ChipGroup label={T.gal.filters} testid="m-create-gallery-filters">
          {/* The 3D chip only where there is a 3D model, so the row of everyone else stays as it was. */}
          {(['all', 'image', 'video', 'audio', ...(has3d || filter === '3d' ? ['3d' as const] : [])] as const).map((id) => (
            <Chip key={id} kind="filter" selected={filter === id} onPress={() => setFilter(id)} testid={`m-create-gallery-filter-${id}`} el="K6.1">
              {id === 'all' ? T.gal.all : id === 'image' ? T.gal.images : id === 'video' ? T.gal.video : id === '3d' ? T.gal.threeD : T.gal.audio}
            </Chip>
          ))}
        </ChipGroup>
      )}
      {items.length === 0 ? (
        <EmptyState title={picking ? T.gal.titlePick : T.gal.title} testid="m-create-gallery-empty">
          {purpose ? T.gal.emptyPick[purpose] : filter === 'all' ? T.gal.empty : T.gal.emptyFilter}
        </EmptyState>
      ) : (
        <div className="m-k-gal" style={{ paddingTop: 8 }} data-testid="m-create-gallery-grid" data-m-count={items.length}>
          {items.map((item) => (
            <Tile key={item.id} item={item} selecting={selectMode} selected={chosen.includes(item.id)} onPress={onPress} />
          ))}
        </div>
      )}
    </Page>
  )
}
