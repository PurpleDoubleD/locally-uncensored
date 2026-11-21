/**
 * M2 Model detail. Route /models/:id, strand 4 (Models and onboarding).
 *
 * The verdict for THIS phone in whole sentences, the main action, the
 * variants (quantizations, each with its own verdict) and the details.
 * The id is a catalogue id, "hf:<repo>" for a search hit, or "file:<name>"
 * for a file on this phone the catalogue does not know.
 *
 * Elements of DESIGN.md: M2.1 variant, M2.2 download, pause, resume, cancel,
 * M2.3 use in chat, M2.4 delete, M2.5 run benchmark, M2.6 view on Hugging
 * Face, M2.7 pick a smaller model, M2.8 use it on LU Cloud.
 */
import { REMOTE_ONLY_MODEL, isRemoteOnlyModel } from '../../lib/phone-engine-limits'
import { useMemo, useState } from 'react'
import { Cloud, Download, ExternalLink, Gauge, Search, Trash2 } from 'lucide-react'
import type { PlannedDownload } from '../../../api/discover'
import { formatBytes } from '../../../lib/formatters'
import { useDownloadStore } from '../../../stores/downloadStore'
import { nav, useParams } from '../../nav'
import { appLinkAllowed, openAppLink } from '../../policy/links'
import { MODELS_STRINGS as S } from '../../strings/models'
import { Button, ErrorState, FitBadge, ListGroup, Notice, Page, Row, SkeletonRows, Tag, toast } from '../../ui'
import { Block, Para } from './parts/bits'
import { checkedDigest, fitOfFile, fitOfNamedFile, parseRouteId, planOfCatalog, planOfVariant, quantOfName, toolsInPacking } from './parts/catalog'
import { useDevice } from './parts/device'
import { deleteModel, loadAndSay, unloadModel, useEngine, useEngineUi } from './parts/engine'
import { answersPoorly, contextText, fitOfCatalogModel, fitView, fitWord, type FitView } from './parts/fit'
import { useVariants } from './parts/hits'
import { bareName, catalogKinOf, catalogModelOf, chatModelId, displayName, fileOf, useInstalled } from './parts/installed'
import { catalogModelOffered, isUnfilteredName, listsUnfiltered, modelBehindFile, repoOffered, showsMarks, storePolicy } from './parts/policy'
import { startDownload } from './parts/start-download'
import { Transfer, useTransferKind } from './parts/Transfer'
import { useActiveChatModel, useUseInChat } from './parts/use-in-chat'
import { showFittingModels, useModelsView } from './parts/view'
import { riskMark } from './parts/risk'


interface Option {
  key: string
  quant: string
  /** File name of the model file. Empty when the variant has none LU can run. */
  filename: string
  sizeBytes: number
  fit: FitView
  plan: PlannedDownload[]
  sharded: boolean
  sha256?: string
}

function NotFound({ text = S.detail.notFound }: { text?: string }) {
  return (
    <Page title={S.detail.fallbackTitle} screen="models-detail">
      <ErrorState
        icon={Search}
        title={S.detail.notFoundTitle}
        testid="m-models-detail-notfound"
        actions={
          <Button testid="m-models-detail-notfound-back" onPress={() => nav.resetTo('models')}>
            {S.detail.backToModels}
          </Button>
        }
      >
        {text}
      </ErrorState>
    </Page>
  )
}

/** The page of a repository at the model hub. */
function hubPage(repo: string): string {
  return `https://huggingface.co/${repo}`
}

export default function ModelDetailPage() {
  const { id } = useParams<{ id: string }>()
  const ref = useMemo(() => parseRouteId(id), [id])
  const { device } = useDevice()
  const installed = useInstalled()
  const engine = useEngine()
  const busy = useEngineUi((s) => s.busy)
  const queuedFile = useEngineUi((s) => s.queued)
  const active = useActiveChatModel()
  const setChatModel = useUseInChat()
  const [chosen, setChosen] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // The digest a download was checked against stays in its record (stores/downloadStore.ts, persisted).
  const digests = useDownloadStore((s) => s.downloadMeta)

  const fileOnPhone = ref.kind === 'file' ? installed.files.find((f) => f.name === ref.name) : undefined
  const known = ref.kind === 'catalog' ? ref.model : fileOnPhone ? catalogModelOf(fileOnPhone) : undefined
  const repo = ref.kind === 'hf' ? ref.repo : (known?.repo ?? null)
  // What the model can do belongs to the model, not to one packing of it: a file on this phone that is another
  // quantization of a catalogue model keeps the marks of that model.
  const facts = known ?? (fileOnPhone ? catalogKinOf(fileOnPhone)?.model : undefined)
  const policy = useMemo(() => storePolicy(), [])
  // Another quantization of a catalogue model has no entry of its own, and its page showed neither where the model
  // comes from nor its license (round 9). Both belong to the model: the catalogue names the repository and the
  // license of the model this file is a build of. Only for what the store policy offers.
  const kin = modelBehindFile(policy, known, facts)
  const hub = repo ?? kin?.repo ?? null
  const licensed = known ?? kin
  // The other files of a repository are foreign files: only where the policy allows them. And a repository this
  // build does not offer is not asked for its files either: its page says "not offered" below and asks nobody.
  const closedRepo = ref.kind === 'hf' && !repoOffered(policy, ref.repo)
  const variants = useVariants(!policy.customModelUrl || closedRepo || (ref.kind === 'file' && !known) ? null : repo)

  const options = useMemo<Option[]>(() => {
    const out: Option[] = []
    if (known) {
      out.push({ key: known.filename, quant: known.quant, filename: known.filename, sizeBytes: known.sizeBytes, fit: fitOfCatalogModel(known, device), plan: planOfCatalog(known), sharded: false, sha256: known.sha256 })
    } else if (fileOnPhone) {
      // A file the catalogue does not list, another packing of a model for one. Before its download the page
      // said "Checked while downloading", afterwards "Not listed by the source" (iPhone review, N5): the page
      // had forgotten the digest. The record of the download has it; a file brought in by hand has no record.
      out.push({ key: `${fileOnPhone.name}.gguf`, quant: quantOfName(fileOnPhone.name) ?? 'GGUF', filename: `${fileOnPhone.name}.gguf`, sizeBytes: fileOnPhone.size, fit: fitOfFile(fileOnPhone, device), plan: [], sharded: false, sha256: checkedDigest(digests, `${fileOnPhone.name}.gguf`) })
    }
    if (variants?.state === 'ready' && repo) {
      for (const variant of variants.variants) {
        const filename = variant.files[0]?.filename ?? ''
        if (out.some((o) => o.filename === filename)) continue
        if (!listsUnfiltered(policy) && isUnfilteredName(filename)) continue
        // By name and size only, exactly as the list "Installed" judges the file once it is on the phone (N1).
        const fit = fitOfNamedFile(filename, variant.totalBytes > 0 ? variant.totalBytes : undefined, device)
        out.push({ key: filename || variant.quant, quant: variant.quant, filename, sizeBytes: variant.totalBytes, fit, plan: planOfVariant(variant), sharded: variant.sharded, sha256: variant.files[0]?.sha256 })
      }
    }
    return out.sort((a, b) => a.sizeBytes - b.sizeBytes)
  }, [known, fileOnPhone, variants, repo, device, policy, digests])

  const preferred = known?.filename ?? options.find((o) => o.quant === 'Q4_K_M' && !o.sharded)?.key ?? options.find((o) => !o.sharded)?.key ?? options[0]?.key ?? null
  const option = options.find((o) => o.key === chosen) ?? options.find((o) => o.key === preferred) ?? null
  const kind = useTransferKind(option?.filename ?? '')
  // The Tools mark belongs to the packing that is chosen on this page, as on its card (parts/catalog.ts): it needs
  // 3 bits or more. The page of a catalogue model showed the mark of the model whatever was chosen, so with
  // IQ2_M picked it said "Tools" above "Packed very small" (check 4 on Android, F5).
  const toolsMark = !!facts && toolsInPacking(facts, option?.quant ?? quantOfName(fileOnPhone?.name ?? '') ?? known?.quant)

  if (ref.kind === 'none') return <NotFound />
  if (ref.kind === 'file' && installed.ready && !fileOnPhone) return <NotFound />
  if (closedRepo) return <NotFound text={S.models.notOffered} />
  // A catalogue model this build does not offer: only its copy on this phone is shown.
  const withdrawn = !!known && !catalogModelOffered(policy, known)
  if (withdrawn && installed.ready && !fileOf(installed.files, known.filename)) return <NotFound text={S.models.notOffered} />

  const name = known?.name ?? (ref.kind === 'hf' ? (ref.repo.split('/')[1] ?? ref.repo).replace(/[-_.]?GGUF$/i, '') : ref.kind === 'file' ? displayName({ name: ref.name }) : S.detail.fallbackTitle)
  const file = option?.filename ? fileOf(installed.files, option.filename) : undefined
  const loaded = !!file && engine.loadedPath === file.path
  const queuedForChat = !!file && queuedFile?.path === file.path
  const loadingThis = busy?.kind === 'loading' && !!file && busy.name === displayName(file)
  const chatModel = !!file && active === chatModelId(file.name)
  const fit = option?.fit ?? fitView({}, device)
  const tooLarge = fit.level === 'too-large' && !file
  const moving = !file && kind !== null && kind !== 'done'
  const sizeText = option && option.sizeBytes > 0 ? formatBytes(option.sizeBytes) : ''
  const reading = !option && variants?.state === 'loading'
  const unreadable = !option && variants?.state === 'failed'
  const empty = !option && variants?.state === 'ready'

  const remoteOnly = isRemoteOnlyModel(name, option?.filename)

  const download = async () => {
    if (!option || starting) return
    if (remoteOnly) {
      toast(REMOTE_ONLY_MODEL, { tone: 'error', testid: 'remote-only' })
      return
    }
    if (option.sharded) {
      toast(S.detail.sharded, { tone: 'error', testid: 'sharded' })
      return
    }
    setStarting(true)
    try {
      await startDownload({ name, files: option.plan, fit })
    } finally {
      setStarting(false)
    }
  }

  const remove = async () => {
    if (!file) return
    const gone = await deleteModel(file, engine.loadedPath)
    if (gone && ref.kind === 'file') nav.back()
  }

  const viewOnHf = async () => {
    if (!hub) return
    const res = await openAppLink(hubPage(hub))
    if (!res.opened) toast(S.detail.openFailed, { tone: 'error', testid: 'open-failed' })
  }

  const context = loaded && engine.status?.ctx ? S.detail.contextLoaded(contextText(engine.status.ctx)) : fit.maxContext > 0 ? S.detail.contextPlanned(contextText(fit.maxContext)) : S.detail.unknown

  return (
    <Page title={name} subtitle={hub ?? undefined} screen="models-detail">
      {reading ? (
        <SkeletonRows label={S.detail.variantsLoading} testid="m-models-detail-loading" />
      ) : unreadable ? (
        <Notice variant="error" testid="m-models-detail-unreadable">
          {S.detail.variantsFailed}
        </Notice>
      ) : empty ? (
        <Notice variant="warn" testid="m-models-detail-nogguf">
          {S.detail.noGguf}
        </Notice>
      ) : (
        <>
          <Block>
            <div className="m-stackv" data-testid="m-models-detail-verdict" data-state={file ? (loaded ? 'loaded' : 'installed') : moving ? (kind ?? 'moving') : fit.level}>
              <span className="m-rowh">
                <FitBadge level={fit.level} text={fitWord(fit)} testid="m-models-detail-fit" />
                {chatModel ? <Tag accent>{S.models.chatModel}</Tag> : null}
                {loaded ? <Tag>{S.common.loaded}</Tag> : file ? <Tag>{S.common.installed}</Tag> : null}
                {facts?.uncensored && showsMarks(policy) ? <Tag>{S.models.tagNoFilter}</Tag> : null}
                {facts?.thinking ? (
                  <span style={{ display: 'contents' }} data-testid="m-models-detail-thinking">
                    <Tag>{S.models.tagThinking}</Tag>
                  </span>
                ) : null}
                {toolsMark ? (
                  <span style={{ display: 'contents' }} data-testid="m-models-detail-tools">
                    <Tag>{S.models.tagTools}</Tag>
                  </span>
                ) : null}
              </span>
              <p className="m-t2" style={{ margin: 0 }} data-testid="m-models-detail-fit-text">
                {file && fit.level === 'too-large' ? S.fit.tooLargeInstalled(formatBytes(fit.needBytes), formatBytes(fit.usableBytes)) : fit.long}
              </p>
              {withdrawn ? (
                <p className="m-cap" style={{ margin: 0 }} data-testid="m-models-detail-withdrawn">
                  {S.models.notOfferedInstalled}
                </p>
              ) : null}
              {answersPoorly(known) ? (
                <p className="m-cap" style={{ margin: 0, color: 'var(--m-warn)' }} data-testid="m-models-detail-weak">
                  {S.models.weakDetail}
                </p>
              ) : null}
              {/* The word is explained where the app may say what such a model does, and nowhere else (parts/policy.ts showsMarks). */}
              {showsMarks(policy) && /abliterated/i.test(name) ? (
                <p className="m-cap" style={{ margin: 0 }} data-testid="m-models-detail-abliterated">
                  {S.detail.abliterated}
                </p>
              ) : null}
              {/* The description of a model that does not refuse says exactly that: advertising, left out without marks. */}
              {known?.description && (!known.uncensored || showsMarks(policy)) ? (
                <p className="m-cap" style={{ margin: 0 }}>
                  {known.description}
                </p>
              ) : null}
              {facts?.thinking ? (
                <p className="m-cap" style={{ margin: 0 }} data-testid="m-models-detail-thinking-note">
                  {S.models.thinkingNote}
                </p>
              ) : null}
            </div>
          </Block>

          <Block>
            <div className="m-stackv" data-testid="m-models-detail-actions">
              {file ? (
                <>
                  {chatModel ? (
                    <p className="m-cap" style={{ margin: 0 }} data-testid="m-models-detail-is-chat">
                      {S.detail.isChatModel}
                    </p>
                  ) : (
                    <Button variant="primary" block testid="m-models-detail-use" el="M2.3" label={S.models.useInChatName(name)} disabled={queuedForChat} disabledReason={queuedForChat ? S.models.loadsAfter(busy?.name ?? '') : undefined} busy={loadingThis} onPress={() => void setChatModel(file)}>
                      {S.detail.useInChat}
                    </Button>
                  )}
                  {loaded ? (
                    <Button block testid="m-models-detail-unload" disabled={!!busy} onPress={() => void unloadModel().then(() => toast(S.models.unloadedToast, { testid: 'unloaded' }))}>
                      {S.detail.unload}
                    </Button>
                  ) : (
                    <Button
                      block
                      testid="m-models-detail-load"
                      disabled={!!busy}
                      busy={busy?.kind === 'loading'}
                      onPress={() => void loadAndSay(file)}
                    >
                      {S.detail.load}
                    </Button>
                  )}
                  <Button
                    block
                    icon={Gauge}
                    testid="m-models-detail-benchmark"
                    el="M2.5"
                    onPress={() => {
                      useModelsView.getState().setBenchModel(file.name)
                      nav.push('/models/benchmark')
                    }}
                  >
                    {S.detail.benchmark}
                  </Button>
                </>
              ) : moving && option ? (
                <Transfer id={option.filename} name={name} screen="models-detail" els={{ pause: 'M2.2', cancel: 'M2.2' }} />
              ) : tooLarge ? (
                <>
                  <Button variant="primary" block testid="m-models-detail-smaller" el="M2.7" onPress={() => { showFittingModels(); nav.resetTo('models') }}>
                    {S.detail.smaller}
                  </Button>
                  <Button variant="cloud" block icon={Cloud} testid="m-models-detail-cloud" el="M2.8" onPress={() => nav.push('/cloud')}>
                    {S.detail.cloud}
                  </Button>
                </>
              ) : remoteOnly && !file ? (
                <p className="m-cap" style={{ margin: 0 }} data-testid="m-models-detail-remote-only">
                  {REMOTE_ONLY_MODEL}
                </p>
              ) : option && option.plan.length > 0 ? (
                <Button variant="primary" block icon={Download} testid="m-models-detail-download" el="M2.2" busy={starting} label={S.common.downloadName(name, sizeText)} onPress={() => void download()}>
                  {sizeText ? S.common.downloadSize(sizeText) : S.common.download}
                </Button>
              ) : null}
              {option?.sharded && !file ? (
                <p className="m-cap" style={{ margin: 0 }} data-testid="m-models-detail-sharded">
                  {S.detail.sharded}
                </p>
              ) : null}
            </div>
          </Block>

          {options.length > 0 ? (
            <ListGroup title={S.detail.variants} role="radiogroup" label={S.detail.variants}>
              {options.map((o) => {
                const there = !!o.filename && !!fileOf(installed.files, o.filename)
                const blocked = o.fit.level === 'too-large' && !there
                return (
                  <div key={o.key} data-testid="m-models-detail-variant" data-m-id={o.quant} data-state={o.key === option?.key ? 'selected' : blocked ? 'too-large' : 'idle'}>
                    <Row
                      title={o.quant}
                      subtitle={<FitBadge level={o.fit.level} text={fitWord(o.fit)} />}
                      value={[o.sizeBytes > 0 ? formatBytes(o.sizeBytes) : null, there ? S.common.installed : null].filter(Boolean).join(', ') || undefined}
                      label={S.detail.variantName(o.quant, o.sizeBytes > 0 ? formatBytes(o.sizeBytes) : '')}
                      radio={{ checked: o.key === option?.key, onSelect: () => setChosen(o.key) }}
                      disabled={blocked || moving}
                      disabledReason={blocked ? S.fit.tooLarge : undefined}
                      testid="m-models-detail-variant-pick"
                      el="M2.1"
                    />
                  </div>
                )
              })}
            </ListGroup>
          ) : null}
          {options.length > 0 ? <Para cap testid="m-models-detail-variants-hint">{S.detail.variantsHint}</Para> : null}

          <ListGroup title={S.detail.details}>
            <Row title={S.detail.fileSize} value={sizeText || S.detail.sizeUnknown} testid="m-models-detail-size" />
            <Row title={S.detail.memory} value={fit.needBytes > 0 ? S.detail.memoryValue(formatBytes(fit.needBytes)) : S.detail.unknown} testid="m-models-detail-memory" />
            <Row title={S.detail.context} value={context} testid="m-models-detail-context" />
            <Row title={S.detail.vision} value={S.detail.visionNo} testid="m-models-detail-vision" />
            <Row title={S.detail.source} value={hub ?? (file ? displayName({ name: bareName(file.name) }) : S.detail.unknown)} subtitle={kin ? S.detail.sourceOfModel : undefined} testid="m-models-detail-source" />
            {licensed ? <Row title={S.detail.license} value={licensed.license} subtitle={licensed.licenseNote} testid="m-models-detail-license" /> : null}
            <Row title={S.detail.checksum} value={option?.sha256 ? (file ? S.detail.checksumVerified : S.detail.checksumOnDownload) : S.detail.checksumNone} testid="m-models-detail-checksum" />
          </ListGroup>

          <ListGroup>
            {/* A link out of the app: only where the store allows more than the legal links (switch externalLinks). */}
            {hub && appLinkAllowed(hubPage(hub)) ? <Row icon={ExternalLink} title={S.detail.viewHf} subtitle={S.detail.viewHfOpens} risk="leaves-app" testid="m-models-detail-hf" el="M2.6" onPress={() => void viewOnHf()} /> : null}
            {file ? <Row icon={Trash2} danger chevron={false} title={S.detail.delete} value={formatBytes(file.size)} {...riskMark('destructive')} testid="m-models-detail-delete" el="M2.4" onPress={() => void remove()} /> : null}
          </ListGroup>
        </>
      )}
    </Page>
  )
}
