/**
 * K13 What you can make. Route /create/showcase, page, strand 3 (Create).
 *
 * One example per tool: a still and two lines of text. K13.1 "Turn on
 * Cloud" or "Sign in", K13.2 "See plans". Both lead to the cloud gate of
 * strand 5 (E3). "See plans" is a way to buying, so it follows the store
 * rules: a button, a sentence without a link, or nothing.
 */
import { useState } from 'react'
import { nav } from '../../nav'
import { CREATE_STRINGS as T } from '../../strings/create'
import { Button, Icon, Page } from '../../ui'
import { useGate } from './parts/facts'
import { purchaseView } from './parts/policy'
import { TOOLS, type ToolId } from './parts/tools'
import { toolProbe, useCatalogVersion } from './parts/catalog'
import { TOOL_ICON } from './parts/ui'
import './parts/create.css'

/** Stills that ship with the app. A tool without one shows its icon on a colour field. */
const STILL: Partial<Record<ToolId, string>> = {
  // The first card is the first thing a visitor sees: it carries a picture, not an icon.
  image: 'two-speakers',
  edit: 'product-scene',
  upscale: 'sharpen-4k',
  video: 'product-360',
  animate: 'animate-character',
  character: 'your-character',
  lipsync: 'talking-avatar',
  music: 'song-from-words',
  motion: 'restyle-video',
}
const TONES = ['a', 'b', 'c', 'd'] as const

function Card({ tool, index }: { tool: ToolId; index: number }) {
  const [broken, setBroken] = useState(false)
  const still = STILL[tool]
  return (
    <article className="m-k-show" data-testid="m-create-showcase-card" data-m-id={tool}>
      <div className="m-k-show-art" data-tone={TONES[index % TONES.length]}>
        {still && !broken ? <img src={`/create-presets/${still}.webp`} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /> : <Icon icon={TOOL_ICON[tool]} />}
      </div>
      <div className="m-k-show-text">
        <h2>{T.tool[tool].name}</h2>
        <p>{T.tool[tool].show}</p>
      </div>
    </article>
  )
}

export default function ShowcasePage() {
  const { gate } = useGate()
  useCatalogVersion()
  const purchase = purchaseView().mode
  const open = gate === 'open'
  const first = gate === 'signed-out' || gate === 'checking' ? T.showcase.signIn : T.showcase.turnOn
  return (
    <Page
      title={T.showcase.title}
      screen="create-showcase"
      flush
      footer={
        <div className="m-k-gap" data-testid="m-create-showcase-actions" data-state={gate} data-m-purchase={purchase}>
          {open ? (
            <Button variant="primary" block onPress={() => nav.resetTo('create')} testid="m-create-showcase-open">
              {T.showcase.open}
            </Button>
          ) : (
            <>
              {gate === 'no-plan' ? null : (
                <Button variant="cloud" block onPress={() => nav.push('/cloud')} testid="m-create-showcase-cloud" el="K13.1">
                  {first}
                </Button>
              )}
              {purchase === 'links' ? (
                <Button block variant={gate === 'no-plan' ? 'cloud' : 'default'} onPress={() => nav.push('/cloud')} risk="paid" testid="m-create-showcase-plans" el="K13.2">
                  {T.showcase.plans}
                </Button>
              ) : purchase === 'text-only' ? (
                <p className="m-k-card-sub" data-testid="m-create-showcase-plans-text">
                  {T.policy.plansElsewhere}
                </p>
              ) : null}
            </>
          )}
        </div>
      }
    >
      <p className="m-k-pad m-k-card-sub m-k-intro">{T.showcase.intro}</p>
      {/* 3D (3.1.0) shows only once the catalog lists a 3D model: the page never names what LU Cloud cannot make. */}
      {TOOLS.filter((tool) => tool.id !== '3d' || toolProbe()['3d']).map((tool, i) => (
        <Card key={tool.id} tool={tool.id} index={i} />
      ))}
    </Page>
  )
}
