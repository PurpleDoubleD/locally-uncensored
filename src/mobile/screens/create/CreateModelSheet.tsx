/**
 * K3 Model. Sheet "create-model", opened with nav.openSheet('create-model'), strand 3 (Create).
 *
 * K3.1 search field, K3.2 model row (radio) with family head, marks and the
 * price at the right in mono, K3.3 "Price details" per row (sub page: price
 * per image, clip or second; for models whose price the server confirms it
 * says so), K3.4 Close is the close button of the sheet.
 * States: the list could not be updated, search without a match, no model.
 */
import { useState } from 'react'
import { Info, Search } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { cloudModelById, refreshCatalog, useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { isStudioModel } from '../../../lib/render/create-studio'
import { effectiveVideoDurations } from '../../../lib/render/video-duration'
import { useContentPolicy } from '../../../hooks/useContentPolicy'
import { useSheet } from '../../nav'
import { useCloudOnline } from '../../resilience/useOnline'
import { CREATE_STRINGS as T } from '../../strings/create'
import { Button, EmptyState, Field, IconButton, ListGroup, Notice, Row, Sheet, Tag, toast } from '../../ui'
import { cheapestModel, pickModel, searchModels, toolModels, useCatalogState, useCatalogVersion, type ModelRow } from './parts/catalog'
import { DirectMark } from '../../policy/DirectMark'
import { createMarksShown, offeredCreateModels } from './parts/policy'
import { useCreateFacts } from './parts/facts'
import { creditsLabel, formatCredits } from './parts/params'

function priceText(row: ModelRow): string | null {
  if (row.credits === null) return null
  const cr = T.model.cr(formatCredits(row.credits))
  return row.quoted ? T.model.fromPrice(cr) : cr
}

function PriceDetails({ row, tool }: { row: ModelRow; tool: string }) {
  const entry = cloudModelById(row.id)
  const c = entry?.credits
  const durations = !isStudioModel(row.id) && (tool === 'video' || tool === 'animate') ? effectiveVideoDurations(row.id) : []
  const lines: { title: string; value: string }[] = []
  if (row.quoted) {
    if (row.credits !== null) lines.push({ title: T.model.perRun, value: T.model.fromPrice(creditsLabel(row.credits)) })
  } else if (tool === 'music' && row.perSecond !== undefined) {
    lines.push({ title: T.model.perSecond, value: creditsLabel(row.perSecond) })
  } else if (durations.length > 0 && c) {
    for (const s of durations) {
      const price = c.by_duration?.[String(s)] ?? (s >= 6.5 ? c.long ?? c.base : c.base)
      lines.push({ title: T.model.perClip(s), value: creditsLabel(price) })
    }
  } else if (row.credits !== null) {
    lines.push({ title: tool === 'character' && entry?.ops?.includes('lora-train') ? T.model.perTraining : entry?.kind === 'image' ? T.model.perImage : T.model.perRun, value: creditsLabel(row.credits) })
  }
  if (c?.lora !== undefined && !row.quoted) lines.push({ title: T.model.withCharacter, value: creditsLabel(c.lora) })
  return (
    <div data-testid="m-create-model-price" data-m-id={row.id}>
      <ListGroup title={row.label}>
        {lines.length === 0 ? <Row title={T.model.unknownPrice} /> : lines.map((l) => <Row key={l.title} title={l.title} value={l.value} />)}
      </ListGroup>
      <p className="m-cap m-k-pad">{row.quoted ? T.model.quoted : T.model.fixed}</p>
    </div>
  )
}

export default function CreateModelSheet() {
  const { sub, pushSub, close } = useSheet()
  const f = useCreateFacts()
  useCatalogVersion()
  const catalog = useCatalogState()
  const online = useCloudOnline()
  const quota = useCloudAuthStore((s) => s.quota)
  const musicSeconds = useCreateStore((s) => s.musicDuration)
  // The mark says what the model can do. While the account still filters it stays pale:
  // the account setting is the boundary, not the model.
  const filtering = useContentPolicy() !== 'off'
  const marks = createMarksShown()
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const rows = offeredCreateModels(
    toolModels(f.tool, {
      character: f.character,
      characterUse: f.characterUse,
      musicSeconds,
      fallbackCredits: { image: quota?.costs.image ?? null, video: quota?.costs.video ?? null, audio: quota?.costs.image ?? null },
      threeDWay: f.threeDWay,
    }),
  )
  const cheapest = cheapestModel(rows)

  if (sub?.startsWith('price:')) {
    const row = rows.find((r) => r.id === sub.slice('price:'.length))
    return <Sheet title={T.model.priceTitle}>{row ? <PriceDetails row={row} tool={f.tool} /> : <EmptyState title={T.model.none} />}</Sheet>
  }

  const found = searchModels(rows, query)
  const groups: { name: string | undefined; rows: ModelRow[] }[] = []
  for (const row of found) {
    const last = groups[groups.length - 1]
    if (last && last.name === row.group) last.rows.push(row)
    else groups.push({ name: row.group, rows: [row] })
  }
  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshCatalog()
    } catch {
      /* said below */
    }
    setRefreshing(false)
    // The button must not end in silence: the list is either there now, or the user hears why not.
    if (useCloudCatalogStore.getState().fetchedAt === null) toast(T.model.refreshFailed, { tone: 'error', testid: 'create-model-refresh-failed' })
    else toast(T.model.refreshed, { testid: 'create-model-refreshed' })
  }

  return (
    <Sheet title={T.model.title}>
      <div className="m-k-sec">
        <Field label={T.model.search} hideLabel type="search" icon={Search} placeholder={T.model.searchPlaceholder} value={query} onChange={setQuery} clearable testid="m-create-model-search" el="K3.1" />
      </div>
      {!catalog.loaded ? (
        <div className="m-k-sec">
          <Notice
            variant="warn"
            testid="m-create-model-stale"
            actions={
              <Button compact busy={refreshing} disabled={!online} disabledReason={T.block.offline} onPress={() => void refresh()} testid="m-create-model-refresh">
                {refreshing ? T.model.refreshing : T.model.refresh}
              </Button>
            }
          >
            {T.model.builtIn}
          </Notice>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={T.model.empty} testid="m-create-model-empty">
          {T.model.emptyText}
        </EmptyState>
      ) : found.length === 0 ? (
        <EmptyState
          title={T.model.none}
          testid="m-create-model-none"
          actions={
            <Button onPress={() => setQuery('')} testid="m-create-model-search-clear">
              {T.model.clearSearch}
            </Button>
          }
        >
          {T.model.noneText}
        </EmptyState>
      ) : (
        <div data-testid="m-create-model-list">
          {groups.map((group, gi) => (
            <section key={`${group.name ?? ''}-${gi}`}>
              {group.name ? <h2 className="m-label m-group-label">{group.name}</h2> : null}
              <div className="m-group" role="radiogroup" aria-label={group.name ?? T.model.list}>
                {group.rows.map((row) => {
                  const price = priceText(row)
                  const checked = row.id === f.model.id
                  return (
                    <div className="m-rowwrap" key={row.id}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        className="m-row"
                        data-testid={row.id === cheapest ? 'm-create-model-cheapest' : 'm-create-model-row'}
                        data-m-id={row.id}
                        data-el="K3.2"
                        onClick={() => {
                          pickModel(f.tool, row.id)
                          close()
                        }}
                      >
                        <span className="m-row-text">
                          <span className="m-row-title">{row.label}</span>
                          {row.tags.length > 0 || (row.adult && marks) ? (
                            <span className="m-k-rowtags">
                              {row.tags.map((t) => (
                                <Tag key={t.label} accent={t.accent}>
                                  {t.label}
                                </Tag>
                              ))}
                              {row.adult && marks ? (
                                <span className={filtering ? 'm-k-pale' : undefined} data-testid="m-create-model-nofilter" data-m-pale={filtering ? '1' : '0'}>
                                  <Tag>{T.model.noFilter}</Tag>
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                        <span className="m-row-end">
                          {price ? <span className="m-k-price">{price}</span> : null}
                          <span className="m-radio" aria-hidden="true" />
                        </span>
                      </button>
                      {row.direct ? <DirectMark testid="m-create-model-direct" /> : null}
                      <IconButton icon={Info} label={T.model.priceDetails(row.label)} onPress={() => pushSub(`price:${row.id}`)} testid="m-create-model-price-open" el="K3.3" />
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </Sheet>
  )
}
