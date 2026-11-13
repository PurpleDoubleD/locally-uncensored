/**
 * The cards of the 3D tool on the stage of K1 (3.1.0, cloud only): the way
 * (Text, Image, Video), the further sides of a model that takes several, the
 * still frames of a video, and the detail step.
 */
import { useEffect, useState } from 'react'
import { Plus, Video as VideoIcon } from 'lucide-react'
import { useCreateStore, type ThreeDWay } from '../../../../stores/createStore'
import { pickFiles, pickPhotos } from '../../../platform/files'
import { Button, Icon, Notice, Progress, Segmented, riskProps, toast } from '../../../ui'
import { CREATE_STRINGS as T } from '../../../strings/create'
import { fileProblemText } from './actions'
import type { CreateFacts } from './facts'
import { loadPhoneImage } from './photos'
import { DETAILS, clearVideo, fitPicks, pickDetail, pickWay, readVideoFrames, shownDetail, tapFrame, useThreeDVideo } from './three-d'
import { THREE_D_WAYS } from './tools'
import { RemoveX } from './ui'

const S = T.threeD

/** The switch at the top of the tool: from words, from a photo, from a video. */
export function ThreeDWaySwitch({ f, disabled }: { f: CreateFacts; disabled: boolean }) {
  const maxViews = f.threeD?.maxViews ?? 1
  return (
    <div className="m-k-sec" data-testid="m-create-3d-way-row">
      <Segmented<ThreeDWay>
        label={S.wayLabel}
        value={f.threeDWay}
        onChange={(way) => pickWay(way, maxViews)}
        options={THREE_D_WAYS.map((way) => ({ value: way, label: S.ways[way], disabled, testid: `m-create-3d-way-${way}` }))}
        testid="m-create-3d-way"
      />
    </div>
  )
}

/** Left, Back, Right for a model that takes several pictures. Front is the source photo. */
export function ThreeDSidesCard({ f, disabled }: { f: CreateFacts; disabled: boolean }) {
  const [busy, setBusy] = useState(false)
  const maxViews = f.threeD?.maxViews ?? 1
  if (!f.source || maxViews <= 1) return null
  const sides = S.sides.slice(1, maxViews)
  const views = f.threeDViews.slice(0, sides.length)
  const next = sides[views.length]
  const add = async () => {
    const [picked] = await pickPhotos({ multiple: false })
    if (!picked) return
    setBusy(true)
    try {
      const ref = await loadPhoneImage(picked.file)
      const st = useCreateStore.getState()
      st.setThreeDViews([...st.threeDViews.slice(0, sides.length), ref].slice(0, sides.length))
    } catch (err) {
      toast(fileProblemText(err), { tone: 'error', testid: 'create-3d-side-failed' })
    } finally {
      setBusy(false)
    }
  }
  const remove = (i: number) => {
    const st = useCreateStore.getState()
    st.setThreeDViews(st.threeDViews.filter((_, k) => k !== i))
  }
  return (
    <div className="m-k-card" data-testid="m-create-3d-sides" data-state={`${views.length}`}>
      <span className="m-k-card-text">
        <span className="m-k-card-title">{S.moreSides}</span>
        <span className="m-k-card-sub">{S.moreSidesSub}</span>
      </span>
      <div className="m-k-refs">
        {views.map((ref, i) => (
          <span className="m-k-ref" key={`${i}-${ref.url.length}`}>
            <span className="m-k-thumb" title={sides[i]}>
              <img src={ref.url} alt={sides[i]} />
            </span>
            {disabled ? null : <RemoveX label={S.removeSide(sides[i])} testid="m-create-3d-side-remove" onPress={() => remove(i)} />}
          </span>
        ))}
        {next ? (
          <button type="button" className="m-k-addtile" aria-label={S.addSide(next)} aria-busy={busy || undefined} disabled={disabled || busy} data-testid="m-create-3d-side-add" {...riskProps('sensor')} onClick={() => void add()}>
            {busy ? <span className="m-ring" aria-hidden="true" /> : <Icon icon={Plus} />}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export type VideoPick = { status: 'cancelled' } | { status: 'ok' } | { status: 'failed'; message: string }

/** Pick a video from Files and read its still frames. Shared by the card and the source sheet. */
export async function pickVideoFor3d(maxViews: number): Promise<VideoPick> {
  const [picked] = await pickFiles({ accept: 'video/*' })
  if (!picked) return { status: 'cancelled' }
  const out = await readVideoFrames(picked.file, maxViews)
  if (out.ok) return { status: 'ok' }
  return { status: 'failed', message: out.reason === 'wrong-kind' ? T.file.wrongKind.video : out.reason === 'empty' ? T.file.empty : S.videoFailed }
}

/** The video of "From video": the moments LU read from it, and which of them go. The video stays on the phone. */
export function ThreeDVideoCard({ f, disabled }: { f: CreateFacts; disabled: boolean }) {
  const video = useThreeDVideo()
  const [problem, setProblem] = useState<string | null>(null)
  const maxViews = f.threeD?.maxViews ?? 1
  const want = Math.max(1, Math.min(4, maxViews))
  useEffect(() => {
    // Another model may take more or fewer pictures: the picks follow it.
    fitPicks(maxViews)
  }, [maxViews])
  const pick = async () => {
    setProblem(null)
    const out = await pickVideoFor3d(maxViews)
    if (out.status === 'failed') setProblem(out.message)
  }
  const problemNote = problem ? (
    <Notice variant="error" testid="m-create-3d-video-error">
      {problem}
    </Notice>
  ) : null

  if (video.reading) {
    return (
      <div className="m-k-card" data-testid="m-create-3d-video" data-state="reading">
        <Progress label={S.reading} detail={video.name ?? S.reading} />
      </div>
    )
  }
  if (!video.frames.length) {
    return (
      <div className="m-k-card m-k-card--add" data-testid="m-create-3d-video" data-state="empty">
        <button type="button" className="m-k-addcard" disabled={disabled} data-testid="m-create-3d-video-add" {...riskProps('sensor')} onClick={() => void pick()}>
          <span className="m-k-thumb" aria-hidden="true">
            <Icon icon={VideoIcon} />
          </span>
          <span className="m-k-card-text">
            <span className="m-sr">{`${S.addVideo}. `}</span>
            <span className="m-k-card-title">{S.videoTitle}</span>
            <span className="m-k-card-sub">{S.videoSub}</span>
          </span>
          <span className="m-k-addcard-go" aria-hidden="true">
            <Icon icon={Plus} small />
          </span>
        </button>
        {problemNote}
      </div>
    )
  }
  const line = want === 1 ? S.framesOne : want === 4 && video.frames.length >= 4 ? S.framesMany : S.framesSome(Math.min(want, video.frames.length))
  return (
    <div className="m-k-card" data-testid="m-create-3d-video" data-state="ready" data-m-picked={video.picked.join(',')}>
      <span className="m-k-card-text">
        <span className="m-k-card-title">{video.name ?? S.videoTitle}</span>
        <span className="m-k-card-sub">{line}</span>
      </span>
      <div className="m-k-frames" role="group" aria-label={line} data-testid="m-create-3d-frames">
        {video.frames.map((frame, i) => {
          const order = video.picked.indexOf(i)
          return (
            <button
              key={frame.url.slice(-24) + i}
              type="button"
              className="m-k-frame"
              aria-pressed={order >= 0}
              aria-label={S.frame(i + 1, video.frames.length)}
              disabled={disabled}
              data-testid="m-create-3d-frame"
              data-m-id={String(i)}
              onClick={() => tapFrame(i, maxViews)}
            >
              <img src={frame.url} alt="" />
              {order >= 0 && want > 1 ? <span className="m-k-frame-no" aria-hidden="true">{order + 1}</span> : null}
            </button>
          )
        })}
      </div>
      <span className="m-k-card-sub">{S.honest}</span>
      {problemNote}
      <div className="m-k-card-actions">
        <Button icon={Plus} onPress={() => void pick()} disabled={disabled} risk="sensor" testid="m-create-3d-video-add">
          {S.otherVideo}
        </Button>
        <Button variant="quiet" onPress={clearVideo} disabled={disabled} testid="m-create-3d-video-remove">
          {T.motionVideoRemove}
        </Button>
      </div>
    </div>
  )
}

/** Draft, Standard, Fine, where the model has a step. It writes the model's own field. */
export function ThreeDDetailCard({ f, disabled }: { f: CreateFacts; disabled: boolean }) {
  const options = useCreateStore((s) => s.cloudStudioOptions)
  const stored = useCreateStore((s) => s.threeDDetail)
  if (!f.threeD?.hasDetail || !f.model.studio) return null
  const value = shownDetail(f.model.id, options, stored)
  return (
    <div className="m-k-card" data-testid="m-create-3d-detail-card">
      <span className="m-k-card-title">{S.detail}</span>
      <Segmented
        label={S.detail}
        value={value}
        onChange={(d) => pickDetail(f.model.id, d)}
        options={DETAILS.map((d) => ({ value: d, label: S.details[d], disabled, testid: `m-create-3d-detail-${d}` }))}
        testid="m-create-3d-detail"
      />
    </div>
  )
}
