/**
 * M1 Models. Route /models, tab root, strand 4 (Models and onboarding).
 *
 * Find local chat models, load them, manage them. Two views: "Get new" (the
 * phone catalogue with filters, and the search on Hugging Face for GGUF
 * repositories) and "Installed" (storage, the models on this phone, benchmark
 * and clean up). Every card carries the fit verdict for THIS phone, from
 * lib/device-fit.ts. A model that is too large is shown, says why, and
 * cannot be downloaded.
 *
 * Elements of DESIGN.md: M1.1 Downloads, M1.2 segment, M1.3 search, M1.4
 * filter chips, M1.5 card opens M2, M1.6 download, M1.7 pause and resume,
 * M1.8 cancel, M1.9 use in chat, M1.10 benchmark, M1.11 clean up partial
 * downloads, M1.12 storage card.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Cpu, Gauge, Search, Trash2 } from 'lucide-react'
import { searchHuggingFaceModels } from '../../../api/discover'
import type { BundledModel } from '../../../api/engine'
import type { DiscoverModel } from '../../../api/model-bundles'
import { formatBytes } from '../../../lib/formatters'
import { useDownloadStore } from '../../../stores/downloadStore'
import { MOBILE_CHAT_MODELS, type MobileModel } from '../../data/mobile-models'
import { nav } from '../../nav'
import { useOnline } from '../../resilience/useOnline'
import { MODELS_STRINGS as S } from '../../strings/models'
import { Button, Chip, ChipGroup, EmptyState, ErrorState, Field, Icon, IconButton, ListGroup, Notice, OfflineIcon, Progress, RootPage, Row, Segmented, SkeletonCards, toast } from '../../ui'
import { activeDownloadCount } from './downloads-badge'
import { deletePartials, partialsOf } from './parts/adapters/downloads'
import { Block, Para, useScreenFit } from './parts/bits'
import { cardOfCatalogWith, cardOfFile, cardOfHit, catalogCardState, defaultVariant, fitOfFile, installedCardTransfers, fitOfVariant, modelsInFlight, packingInFlight, planOfCatalog, planOfVariant, repoOfHit } from './parts/catalog'
import { useDevice } from './parts/device'
import { loadAndSay, unloadModel, useEngine } from './parts/engine'
import { anyReadsImages, deviceLine, filterCatalog, fitOfCatalogModel, type CatalogFilters } from './parts/fit'
import { loadVariantsOf, useDebounced, useVariantStore } from './parts/hits'
import { chatFiles, chatModelId, fileOf, useInstalled } from './parts/installed'
import { ModelCard } from './parts/ModelCard'
import { hubSearchOffered, listsUnfiltered, offeredCatalog, repoOffered, storePolicy } from './parts/policy'
import { useRecheck } from './parts/recheck'
import { startDownload } from './parts/start-download'
import { useActiveChatModel, useUseInChat } from './parts/use-in-chat'
import { useModelsView, type ModelsSegment } from './parts/view'
import { riskMark } from './parts/risk'

const FILTER_CHIPS: ReadonlyArray<{ key: keyof CatalogFilters; label: string; testid: string }> = [
  { key: 'fitsOnly', label: S.models.filterFits, testid: 'm-models-filter-fits' },
  { key: 'mainstream', label: S.models.filterMainstream, testid: 'm-models-filter-mainstream' },
  { key: 'unfiltered', label: S.models.filterUnfiltered, testid: 'm-models-filter-unfiltered' },
  { key: 'vision', label: S.models.filterVision, testid: 'm-models-filter-vision' },
]

type SearchState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; hits: DiscoverModel[] }

function useSearch(query: string, online: boolean): SearchState {
  const [result, setResult] = useState<{ query: string; hits: DiscoverModel[] } | null>(null)
  useEffect(() => {
    if (!query || !online) return
    let alive = true
    void searchHuggingFaceModels(query).then((hits) => {
      if (!alive) return
      setResult({ query, hits })
      loadVariantsOf(hits.map(repoOfHit))
    }, () => {
      // The search now throws when HuggingFace does not answer. This screen
      // keeps its earlier behaviour: an empty list instead of a spinner forever.
      if (alive) setResult({ query, hits: [] })
    })
    return () => {
      alive = false
    }
  }, [query, online])
  if (!query) return { state: 'idle' }
  return result && result.query === query ? { state: 'ready', hits: result.hits } : { state: 'loading' }
}

interface CardActions {
  useInChat: (file: BundledModel) => void
  load: (file: BundledModel) => void
  unload: () => void
}

function HitCard({ hit, actions }: { hit: DiscoverModel; actions: CardActions }) {
  const repo = repoOfHit(hit)
  const entry = useVariantStore((s) => s.byRepo[repo])
  const { device } = useDevice()
  const { files } = useInstalled()
  const engine = useEngine()
  const active = useActiveChatModel()
  const variant = entry?.state === 'ready' ? defaultVariant(entry.variants) : undefined
  const fit = fitOfVariant(variant, device)
  const card = cardOfHit(hit, variant)
  const file = card.filename ? fileOf(files, card.filename) : undefined
  return (
    <ModelCard
      model={card}
      fit={fit}
      file={file}
      engine={engine}
      chatModel={!!file && active === chatModelId(file.name)}
      sizing={!entry || entry.state === 'loading'}
      onDownload={() => {
        if (!variant) {
          toast(S.detail.noGguf, { tone: 'error', testid: 'no-gguf' })
          return
        }
        if (variant.sharded) {
          toast(S.detail.sharded, { tone: 'error', testid: 'sharded' })
          return
        }
        void startDownload({ name: hit.name, files: planOfVariant(variant), fit })
      }}
      onUseInChat={actions.useInChat}
      onLoad={actions.load}
      onUnload={actions.unload}
    />
  )
}

function CatalogCard({ model, actions }: { model: MobileModel; actions: CardActions }) {
  const { device } = useDevice()
  const { files } = useInstalled()
  const engine = useEngine()
  const active = useActiveChatModel()
  const fit = fitOfCatalogModel(model, device)
  // Another packing of this model that is on the phone or on its way stands for it on the card (G11).
  const inFlight = useDownloadStore((s) => packingInFlight(model, s.downloads))
  const { file, packing, transfer, beside } = catalogCardState(model, files, inFlight, { loadedPath: engine.loadedPath, activeChatModel: active })
  return (
    <ModelCard
      model={cardOfCatalogWith(model, packing)}
      fit={packing && file ? fitOfFile(file, device) : fit}
      file={file}
      packing={packing}
      transfer={transfer}
      beside={beside}
      engine={engine}
      chatModel={!!file && active === chatModelId(file.name)}
      onDownload={() => void startDownload({ name: model.name, files: planOfCatalog(model), fit })}
      onUseInChat={actions.useInChat}
      onLoad={actions.load}
      onUnload={actions.unload}
    />
  )
}

function GetNew({ actions }: { actions: CardActions }) {
  const { filters, query, setQuery, toggleFilter, setFilters, wantsVision } = useModelsView()
  const { ready, device, freeBytes, resolved } = useDevice()
  const installed = useInstalled()
  const online = useOnline()
  const { checking, recheck } = useRecheck()
  const { narrow } = useScreenFit()
  const asked = useDebounced(query.trim(), 450)
  const policy = useMemo(() => storePolicy(), [])
  // Store switch hubSearch: a build without the open search has no field, and a text that is still there asks nobody.
  const hubSearch = hubSearchOffered(policy)
  const search = useSearch(hubSearch ? asked : '', online)
  const offered = useMemo(() => offeredCatalog(policy, MOBILE_CHAT_MODELS), [policy])
  const models = useMemo(() => filterCatalog(offered, device, filters), [offered, device, filters])
  // "Vision" is a chip only while a model of the catalogue can read images on the phone. Today none can.
  const vision = useMemo(() => anyReadsImages(offered), [offered])
  // Without the search a text that is still in the field means nothing.
  const searching = hubSearch && query.trim().length > 0
  const chips = FILTER_CHIPS.filter((chip) => (chip.key === 'vision' ? vision : listsUnfiltered(policy) || (chip.key !== 'unfiltered' && chip.key !== 'mainstream')))
  // Without internet the catalogue gives way to one sentence. A download that was started here stays in sight.
  const rows = useDownloadStore((state) => state.downloads)
  const inFlight = useMemo(() => (online ? [] : modelsInFlight(offered, rows)), [online, offered, rows])
  const hits = search.state === 'ready' ? search.hits.filter((hit) => repoOffered(policy, repoOfHit(hit))) : []

  return (
    <>
      {hubSearch ? (
        <Block>
          {/* "Search Hugging Face" is cut off in a field of 320 px at 200 percent. There the field says "Search" and the line below names the source. */}
          <Field label={S.models.search} hideLabel placeholder={narrow ? S.models.searchShort : S.models.search} hint={narrow ? S.models.searchHint : undefined} type="text" inputMode="search" icon={Search} clearable value={query} onChange={setQuery} testid="m-models-search" el="M1.3" />
        </Block>
      ) : null}
      {wantsVision && !vision && !searching ? (
        <Notice
          title={S.models.visionWishTitle}
          testid="m-models-vision-wish"
          actions={
            <Button compact testid="m-models-vision-wish-ok" onPress={() => useModelsView.setState({ wantsVision: false })}>
              {S.models.visionWishOk}
            </Button>
          }
        >
          {S.models.visionWish}
        </Notice>
      ) : null}
      {searching ? null : (
        <div style={{ marginBottom: 'var(--m-s3)' }}>
          <ChipGroup wrap label={S.models.filters} testid="m-models-filters" el="M1.4">
            {chips.map((chip) => (
              <Chip key={chip.key} kind="filter" selected={filters[chip.key]} testid={chip.testid} onPress={() => toggleFilter(chip.key)}>
                {chip.label}
              </Chip>
            ))}
          </ChipGroup>
        </div>
      )}
      {!online ? (
        <>
          {inFlight.length > 0 ? (
            <div data-testid="m-models-catalog-inflight">
              {inFlight.map((model) => (
                <CatalogCard key={model.id} model={model} actions={actions} />
              ))}
            </div>
          ) : null}
          <ErrorState
            icon={OfflineIcon}
            title={S.models.offlineTitle}
            testid="m-models-offline"
            actions={
              <Button testid="m-models-offline-retry" busy={checking} onPress={recheck}>
                {checking ? S.common.checking : S.common.tryAgain}
              </Button>
            }
          >
            {S.models.offline}
          </ErrorState>
        </>
      ) : searching ? (
        search.state !== 'ready' ? (
          <SkeletonCards label={S.models.searching} testid="m-models-searching" />
        ) : hits.length === 0 ? (
          <EmptyState
            icon={Search}
            title={S.models.searchEmptyTitle}
            testid="m-models-search-empty"
            actions={
              <Button testid="m-models-search-clear" onPress={() => setQuery('')}>
                {S.models.clearSearch}
              </Button>
            }
          >
            {S.models.searchEmpty(asked)}
          </EmptyState>
        ) : (
          <div data-testid="m-models-hits">
            <h2 className="m-label m-group-label">{S.models.searchResults}</h2>
            {hits.map((hit) => (
              <HitCard key={repoOfHit(hit)} hit={hit} actions={actions} />
            ))}
          </div>
        )
      ) : !ready || !installed.ready ? (
        <SkeletonCards label={S.common.loadingCatalog} testid="m-models-loading" />
      ) : (
        <>
          <p className="m-pad m-cap m-rowh" style={{ margin: '0 0 var(--m-s2)', alignItems: 'flex-start', flexWrap: 'nowrap' }} data-testid="m-models-device">
            <Icon icon={Cpu} small />
            <span style={{ minWidth: 0 }}>{resolved?.source === 'override' && resolved.label ? `${S.device.pretend(resolved.label)}. ` : ''}{deviceLine(device, freeBytes)}</span>
          </p>
          <Para cap testid="m-models-small-note">
            {S.models.smallNote}
          </Para>
          {models.length === 0 ? (
            <EmptyState
              icon={Search}
              title={S.models.filterEmptyTitle}
              testid="m-models-filter-empty"
              actions={
                <Button testid="m-models-filter-clear" onPress={() => setFilters({ fitsOnly: false, mainstream: false, unfiltered: false, vision: false })}>
                  {S.models.showAll}
                </Button>
              }
            >
              {S.models.filterEmpty}
            </EmptyState>
          ) : (
            <div data-testid="m-models-catalog">
              {models.map((model) => (
                <CatalogCard key={model.id} model={model} actions={actions} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

function StorageCard() {
  const { files } = useInstalled()
  const { freeBytes } = useDevice()
  const used = files.reduce((sum, f) => sum + (f.size || 0), 0)
  const total = freeBytes === null ? 0 : used + freeBytes
  const text = [S.models.storageUsed(formatBytes(used)), freeBytes === null ? null : S.models.storageFree(formatBytes(freeBytes))].filter(Boolean).join(' · ')
  return (
    <button type="button" className="m-card" style={{ display: 'block', width: 'calc(100% - var(--m-gutter) * 2)', textAlign: 'left', color: 'inherit' }} aria-label={S.models.storageOpen} data-testid="m-models-storage" data-el="M1.12" onClick={() => nav.push('/settings/storage')}>
      <span className="m-stackv">
        <span className="m-rowh" style={{ justifyContent: 'space-between' }}>
          <span className="m-card-title">{S.models.storageCard}</span>
          <span className="m-mono m-t3">{text}</span>
        </span>
        <Progress label={S.models.storageCard} value={total > 0 ? used / total : 0} hidePercent />
      </span>
    </button>
  )
}

function Installed({ actions, onGetNew }: { actions: CardActions; onGetNew: () => void }) {
  const { ready, files } = useInstalled()
  const { device } = useDevice()
  const engine = useEngine()
  const active = useActiveChatModel()
  const orphans = useDownloadStore((s) => s.orphans)
  const partials = partialsOf(orphans)
  const chat = chatFiles(files)
  // The download of a further packing of a model that is here already shows on its card, as in "Get new" (F13).
  const transfersKey = useDownloadStore((st) => JSON.stringify(installedCardTransfers(chat, st.downloads)))
  const transfers = useMemo(() => JSON.parse(transfersKey) as ReturnType<typeof installedCardTransfers>, [transfersKey])

  const cleanUp = async () => {
    if (partials.count === 0) {
      toast(S.models.cleanupNone, { testid: 'cleanup-none' })
      return
    }
    const yes = await nav.confirm({
      title: S.models.cleanupTitle,
      text: S.models.cleanupText(formatBytes(partials.bytes)),
      confirmLabel: S.models.cleanupConfirm,
      cancelLabel: S.common.keep,
      tone: 'danger',
      testid: 'cleanup',
    })
    if (!yes) return
    const freed = await deletePartials()
    toast(S.models.cleanupDone(formatBytes(freed)), { testid: 'cleanup-done' })
  }

  return (
    <>
      <StorageCard />
      {!ready ? (
        <SkeletonCards cards={2} label={S.common.loadingCatalog} testid="m-models-loading" />
      ) : chat.length === 0 ? (
        <EmptyState
          title={S.models.emptyTitle}
          testid="m-models-empty"
          actions={
            <Button variant="primary" testid="m-models-empty-getnew" onPress={onGetNew}>
              {S.models.getNew}
            </Button>
          }
        >
          {S.models.empty}
        </EmptyState>
      ) : (
        <div data-testid="m-models-installed">
          {chat.map((file) => (
            <ModelCard
              key={file.path}
              model={cardOfFile(file)}
              fit={fitOfFile(file, device)}
              file={file}
              transfer={transfers[file.path]}
              engine={engine}
              chatModel={active === chatModelId(file.name)}
              onDownload={() => {}}
              onUseInChat={actions.useInChat}
              onLoad={actions.load}
              onUnload={actions.unload}
            />
          ))}
        </div>
      )}
      <ListGroup>
        <Row icon={Gauge} title={S.models.benchmark} subtitle={S.models.benchmarkSub} testid="m-models-benchmark" el="M1.10" onPress={() => nav.push('/models/benchmark')} />
        <Row
          icon={Trash2}
          chevron={false}
          title={S.models.cleanup}
          subtitle={partials.count > 0 ? S.models.cleanupSize(partials.count, formatBytes(partials.bytes)) : S.models.cleanupNone}
          {...riskMark('destructive')} testid="m-models-partials-clear"
          el="M1.11"
          onPress={() => void cleanUp()}
        />
      </ListGroup>
    </>
  )
}

/** The arrival the page already started at its top for. Lives longer than the page, which is unmounted on a tab switch. */
let arrivalShown = 0

export default function ModelsPage() {
  const { segment, setSegment } = useModelsView()
  const arrivals = useModelsView((s) => s.arrivals)
  const top = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Sent here with a view set (parts/view.ts, showModelsWith): start at the top, not where the page was left.
    // Runs after the page restored its remembered position, and wins.
    if (arrivals === arrivalShown) return
    arrivalShown = arrivals
    const body = top.current?.closest('.m-body')
    if (body) body.scrollTop = 0
  }, [arrivals])
  const downloads = useDownloadStore((s) => activeDownloadCount(s.downloads))
  const failure = useDownloadStore((s) => Object.values(s.downloads).some((row) => row.status === 'error'))
  const setChatModel = useUseInChat()
  const actions: CardActions = {
    useInChat: (file) => void setChatModel(file),
    load: (file) => void loadAndSay(file),
    unload: () => void unloadModel().then(() => toast(S.models.unloadedToast, { testid: 'unloaded' })),
  }

  return (
    <RootPage
      title={S.models.title}
      screen="models"
      actions={<IconButton icon={ArrowDownToLine} label={S.models.downloads} count={downloads} countWord={S.models.downloadsWord} testid="m-models-downloads" el="M1.1" onPress={() => nav.push('/models/downloads')} />}
    >
      <div ref={top} />
      <Block>
        <Segmented<ModelsSegment>
          label={S.models.segment}
          testid="m-models-segment"
          el="M1.2"
          value={segment}
          onChange={setSegment}
          options={[
            { value: 'new', label: S.models.getNew, testid: 'm-models-segment-new' },
            { value: 'installed', label: S.models.installed, testid: 'm-models-segment-installed' },
          ]}
        />
      </Block>
      {failure && downloads === 0 ? (
        <Notice variant="warn" testid="m-models-download-notice" actions={<Button compact testid="m-models-download-notice-open" onPress={() => nav.push('/models/downloads')}>{S.storage.openDownloads}</Button>}>
          {S.download.failed}
        </Notice>
      ) : null}
      {segment === 'new' ? <GetNew actions={actions} /> : <Installed actions={actions} onGetNew={() => setSegment('new')} />}
    </RootPage>
  )
}
