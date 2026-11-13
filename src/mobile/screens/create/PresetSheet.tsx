/**
 * K12 What a step of a guided preset opens. Sheet "create-preset", opened
 * with nav.openSheet('create-preset', { view }), strand 3 (Create).
 *
 * One sheet with several faces, because all of them work on the same step
 * (parts/guided-run.ts): `model` the models the step may run on, `more` the
 * settings that are not on the page, `field` one choice list of the provider
 * schema (a presenter, a language), `style` the fixed visual styles of a
 * restyle model, `voice` the voices of the speech model, `ideas` prompt
 * ideas, `gallery` the gallery as a picker for an input of the step.
 */
import { memo, useRef } from 'react'
import { AudioLines, Box, Play } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useContentPolicy } from '../../../hooks/useContentPolicy'
import { useSheet } from '../../nav'
import { CREATE_STRINGS as T } from '../../strings/create'
import { EmptyState, Icon, ListGroup, Row, Sheet, Tag, TextArea } from '../../ui'
import { CLASSIC_VOICES, classicControls, inputKindOf, stepFields, withIdea, type InputKind } from './parts/guided'
import { attachGuidedItem, chooseGuidedModel, runBusy, setGuidedClip, setGuidedOption, setGuidedPrompt, useGuided, viewOf } from './parts/guided-run'
import { modelHint } from '../../../lib/render/preset-models'
import { createMarksShown, offeredCreateModels, shownCreateModel, withAiConsent } from './parts/policy'
import { DirectMark } from '../../policy/DirectMark'
import { SchemaFields, SchemaSub, isSchemaSub, schemaSubTitle, type SchemaHost } from './parts/SchemaFields'
import { MediaStateBox, itemName, useCloseOwnSheet, useItemMedia, useNearViewport } from './parts/ui'

export type PresetSheetProps =
  | { view: 'model' | 'more' | 'style' | 'voice' | 'ideas' }
  | { view: 'field'; sub: string }
  /** `slot` is the job parameter the pick goes into ("source_path", or "source_url" for the clip to continue). */
  | { view: 'gallery'; slot: string }

const PickTile = memo(function PickTile({ item, onPick }: { item: GalleryItem; onPick: (item: GalleryItem) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearViewport(ref)
  const media = useItemMedia(item)
  const show = near && media.state === 'ok' && media.url
  return (
    <div ref={ref} className="m-k-tile" data-testid="m-create-preset-pick-tile" data-m-id={item.id} data-state={media.state}>
      <button type="button" className="m-k-tile-main" aria-label={T.gal.pick(itemName(item))} data-testid="m-create-preset-pick" data-m-id={item.id} onClick={() => onPick(item)}>
        {show && item.type === 'image' ? <img src={media.url ?? undefined} alt="" loading="lazy" decoding="async" onError={media.onError} /> : null}
        {show && item.type === 'video' ? <video src={`${media.url}#t=0.1`} muted playsInline preload="metadata" onError={media.onError} /> : null}
        {item.type === 'audio' && media.state === 'ok' ? <Icon icon={AudioLines} /> : null}
        {item.type === '3d' && media.state === 'ok' ? <Icon icon={Box} /> : null}
        {media.state !== 'ok' ? <MediaStateBox state={media.state} compact /> : null}
      </button>
      {item.type !== 'image' && media.state === 'ok' ? (
        <span className="m-k-tile-badge">
          {item.type === 'video' ? <Play /> : item.type === '3d' ? <Box /> : <AudioLines />}
          {T.gal.kind[item.type]}
        </span>
      ) : null}
    </div>
  )
})

function GalleryPick({ slot, onDone }: { slot: string; onDone: () => void }) {
  const gallery = useCreateStore((s) => s.gallery)
  const clip = slot === 'source_url'
  const kind: InputKind = clip ? 'video' : inputKindOf(slot)
  // Only what can be handed over: a result that still exists, and for the clip one the cloud still has by its address.
  const items = gallery.filter((g) => g.type === kind && !g.unavailable && (!clip || !!g.remoteUrl))
  if (items.length === 0) {
    return (
      <EmptyState title={T.guided.galleryEmptyTitle} testid="m-create-preset-pick-empty">
        {T.guided.galleryEmpty[kind]}
      </EmptyState>
    )
  }
  const pick = (item: GalleryItem) => {
    if (clip) {
      setGuidedClip(item)
      onDone()
      return
    }
    onDone()
    // The bytes of the result go to the cloud again: the same question as for a file of the phone.
    void withAiConsent(async () => {
      await attachGuidedItem(slot, item)
    })
  }
  return (
    <div className="m-k-gal" data-testid="m-create-preset-pick-grid" data-m-count={items.length}>
      {items.map((item) => (
        <PickTile key={item.id} item={item} onPick={pick} />
      ))}
    </div>
  )
}

export default function PresetSheet() {
  const { props, sub, pushSub, back } = useSheet<PresetSheetProps | undefined>()
  const closeOwn = useCloseOwnSheet()
  const s = useGuided()
  const filtering = useContentPolicy() !== 'off'
  const view = viewOf(s)
  const which = props?.view ?? 'more'
  if (!view) {
    return (
      <Sheet title={T.guided.title}>
        <EmptyState title={T.guided.notFoundTitle} testid="m-create-preset-sheet-empty">
          {T.guided.notFoundText}
        </EmptyState>
      </Sheet>
    )
  }
  const locked = runBusy(s) || !!s.done[s.index]
  const host: SchemaHost = { model: view.model, options: s.options, set: setGuidedOption, disabled: locked }

  // A choice list opened from a list of this sheet: one step back returns to that list.
  if (isSchemaSub(sub) && view.studio) {
    return (
      <Sheet title={schemaSubTitle(sub)}>
        <SchemaSub host={host} sub={sub} onDone={back} onOpen={pushSub} />
      </Sheet>
    )
  }
  if (props?.view === 'field' && view.studio && isSchemaSub(props.sub)) {
    return (
      <Sheet title={schemaSubTitle(props.sub)}>
        <SchemaSub host={host} sub={props.sub} onDone={closeOwn} onOpen={pushSub} />
      </Sheet>
    )
  }
  if (which === 'model') {
    return (
      <Sheet title={T.guided.modelTitle}>
        <ListGroup role="radiogroup" label={T.guided.modelTitle} testid="m-create-preset-models">
          {offeredCreateModels(view.alternatives).map((m) => (
            <Row
              key={m.id}
              id={m.id}
              title={shownCreateModel(m).name}
              trailing={shownCreateModel(m).direct ? <DirectMark testid="m-create-preset-direct" /> : undefined}
              subtitle={modelHint(m.id)}
              end={m.adult && createMarksShown() ? (
                <span className={filtering ? 'm-k-pale' : undefined} data-m-pale={filtering ? '1' : '0'}>
                  <Tag>{T.guided.noFilter}</Tag>
                </span>
              ) : undefined}
              radio={{
                checked: m.id === view.model,
                reselect: true,
                onSelect: () => {
                  chooseGuidedModel(m.id)
                  closeOwn()
                },
              }}
              disabled={locked}
              testid="m-create-preset-model-option"
            />
          ))}
        </ListGroup>
      </Sheet>
    )
  }
  if (which === 'style' && view.promptChoices) {
    return (
      <Sheet title={T.guided.style}>
        <ListGroup role="radiogroup" label={T.guided.style} testid="m-create-preset-styles">
          {view.promptChoices.map((choice) => (
            <Row
              key={choice}
              id={choice}
              title={choice}
              radio={{
                checked: s.prompt === choice,
                reselect: true,
                onSelect: () => {
                  setGuidedPrompt(choice)
                  closeOwn()
                },
              }}
              disabled={locked}
              testid="m-create-preset-style-option"
            />
          ))}
        </ListGroup>
      </Sheet>
    )
  }
  if (which === 'voice') {
    const current = String(s.options.voice ?? 'Serena')
    return (
      <Sheet title={T.guided.voice}>
        <ListGroup role="radiogroup" label={T.guided.voice} testid="m-create-preset-voices">
          {CLASSIC_VOICES.map((voice) => (
            <Row
              key={voice}
              id={voice}
              title={voice.replaceAll('_', ' ')}
              radio={{
                checked: current === voice,
                reselect: true,
                onSelect: () => {
                  setGuidedOption('voice', voice)
                  closeOwn()
                },
              }}
              disabled={locked}
              testid="m-create-preset-voice-option"
            />
          ))}
        </ListGroup>
      </Sheet>
    )
  }
  if (which === 'ideas') {
    return (
      <Sheet title={T.guided.ideasTitle}>
        <p className="m-cap m-k-pad m-k-intro">{T.guided.ideasHint}</p>
        <ListGroup testid="m-create-preset-idea-list">
          {view.ideas.map((idea) => (
            <Row
              key={idea.label}
              title={idea.label}
              subtitle={idea.text}
              chevron={false}
              disabled={locked}
              onPress={() => {
                setGuidedPrompt(withIdea(useGuided.getState().prompt, idea.text))
                closeOwn()
              }}
              testid="m-create-preset-idea"
            />
          ))}
        </ListGroup>
      </Sheet>
    )
  }
  if (props?.view === 'gallery') {
    const kind: InputKind = props.slot === 'source_url' ? 'video' : inputKindOf(props.slot)
    return (
      <Sheet title={T.guided.galleryTitle[kind]}>
        <GalleryPick slot={props.slot} onDone={closeOwn} />
      </Sheet>
    )
  }
  // "More settings": what the page itself does not show.
  const fields = stepFields(view)
  const classic = classicControls(view)
  return (
    <Sheet title={T.guided.more}>
      {fields.other.length > 0 ? <SchemaFields host={host} only={fields.other} onOpen={pushSub} /> : null}
      {classic.negative ? (
        <div className="m-k-sec">
          <TextArea label={T.guided.negative} hint={T.guided.negativeHint} value={String(s.options.negative_prompt ?? '')} onChange={(v) => setGuidedOption('negative_prompt', v)} rows={3} maxLength={1000} disabled={locked} testid="m-create-preset-negative" />
        </div>
      ) : null}
    </Sheet>
  )
}
