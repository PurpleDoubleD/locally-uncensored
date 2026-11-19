// The settings of the Character tab, behind the one settings icon of the
// prompt window (David, 16.11.2026: in the window only the text field, the
// upload, the settings and Create; everything else of a tab goes here). They
// stand at the head of the settings drawer, above the model's own values:
// the model, the size and quality of the run, the prompt's helpers, and for
// Swap its length and its engines.

import { useEffect, useState, type ReactNode } from 'react'
import { useCreateStore } from '../../../../stores/createStore'
import { isMlxImageHost } from '../../../../api/mlx-image'
import { useCharacterHubReleased } from '../../../../lib/create/character-hub-release'
import { LaneControls } from '../Composer'
import { ModelChip } from '../ModelChip'
import { PromptAssistant } from '../PromptAssistant'
import { PromptHistory } from '../PromptHistory'
import { SpecialMore } from '../SpecialIntentControls'
import { mediaSeconds } from '../useStudioPrice'
import { cn } from '../../ui/cn'
import { SwapLength, SwapPrice } from './SwapBarParts'
import { SwapPicks } from './SwapOneClick'
import { useHubRun } from './hubRun'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5" data-hub-setting={label}>
      <span className="hub-muted w-[80px] shrink-0 hub-fs-125">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  )
}

export function HubSettings({ onOpenWorkflows }: { onOpenWorkflows?: () => void }) {
  const intent = useCreateStore((s) => s.intent())
  const backend = useCreateStore((s) => s.backend)
  const training = useCreateStore((s) => s.intent() === 'character' && s.characterTab === 'train')
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const showNegative = useCreateStore((s) => s.showNegative)
  const toggleNegative = useCreateStore((s) => s.toggleNegative)
  const videoInput = useCreateStore((s) => s.videoInput)
  const released = useCharacterHubReleased()
  // What the prompt window takes on this action (the Composer says it).
  const takes = useHubRun((s) => s.window)
  const swap = intent === 'swap_character'
  const oneClick = swap && released && backend === 'cloud'

  const [measured, setMeasured] = useState<{ url: string; seconds: number | undefined } | null>(null)
  useEffect(() => {
    let alive = true
    if (!oneClick || !videoInput) return
    void mediaSeconds(videoInput.url, 'video').then((v) => { if (alive) setMeasured({ url: videoInput.url, seconds: v }) })
    return () => { alive = false }
  }, [oneClick, videoInput])
  const videoSeconds = measured && videoInput && measured.url === videoInput.url ? measured.seconds : undefined

  return (
    <div className="lu-hub border-b border-white/10 pb-3 mb-3 space-y-1" data-hub-settings>
      {/* Swap on this computer picks its Wan 2.2 Animate file here like any
          local lane (localPick narrows the list to the Animate models). */}
      {(!swap || backend === 'local') && !training && <Row label="Model"><ModelChip /></Row>}
      {oneClick && (
        <>
          <SwapPicks />
          {videoInput && <Row label="Length"><SwapLength videoSeconds={videoSeconds} /><SwapPrice videoSeconds={videoSeconds} /></Row>}
        </>
      )}
      {swap && <div className="space-y-2 pt-1"><SpecialMore intent={intent} /></div>}
      {(!swap || backend === 'local') && !training && <div className="pt-1 empty:hidden"><LaneControls /></div>}
      {takes.prompt && (
        <Row label="Prompt">
          {takes.negative && (
            <button
              type="button"
              onClick={toggleNegative}
              aria-pressed={showNegative}
              aria-controls="negative-prompt-field"
              className={cn('t-control px-2 h-[var(--control-h-sm)] rounded-md transition-colors', showNegative ? 'bg-white/10 text-gray-200' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.05]')}
              title="Say what the render should avoid"
            >
              Negative
            </button>
          )}
          <PromptHistory onPick={setPrompt} />
          <PromptAssistant onUse={setPrompt} align="left" />
        </Row>
      )}
      {backend === 'local' && !isMlxImageHost() && onOpenWorkflows && (
        <button type="button" onClick={onOpenWorkflows} className="t-control text-gray-400 underline decoration-white/15 underline-offset-[3px] hover:text-gray-200" data-hub-workflows>
          Use your own ComfyUI workflow
        </button>
      )}
    </div>
  )
}
