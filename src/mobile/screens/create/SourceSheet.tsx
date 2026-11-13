/**
 * K5 Add source. Sheet "source", opened with nav.openSheet('source'), strand 3 (Create).
 *
 * K5.1 Take photo, K5.2 Photo library (several photos start a batch where
 * the tool can run one), K5.3 File, K5.4 From gallery (opens K6 as a
 * picker), K5.5 Saved characters (sub page), K5.6 Close is the close button
 * of the sheet. 3D (3.1.0) adds Video: LU reads still frames of it, the
 * video itself stays on the phone.
 * States: the photo is being prepared, the file is too large, the format
 * cannot be read.
 */
import { useEffect, useState } from 'react'
import { Camera, Film, FolderOpen, Images, LayoutGrid, Trash2, UsersRound } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { deleteSavedCharacter, listSavedCharacters, subscribeSavedCharacters, type SavedCharacter } from '../../../lib/saved-characters'
import { MAX_STORED_REFERENCES } from '../../../lib/edit-references'
import { nav, useSheet } from '../../nav'
import { useCloseOwnSheet } from './parts/ui'
import { takePhoto } from '../../platform/camera'
import { pickFiles, pickPhotos } from '../../platform/files'
import { openGalleryPicker } from './parts/actions'
import { CREATE_STRINGS as T } from '../../strings/create'
import { EmptyState, IconButton, ListGroup, Notice, Progress, Row, Sheet, SkeletonRows, toast } from '../../ui'
import { addSourceFiles, fileProblemText, takeImageAsSource } from './parts/actions'
import { loadPhoneImageFromBlob } from './parts/photos'
import { toolFacts, toolTakesPhoto } from './parts/tools'
import { pickVideoFor3d } from './parts/ThreeDCards'
import { threeDModelFacts } from './parts/three-d'
import { useCreateFacts } from './parts/facts'

function SavedCharacters({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<SavedCharacter[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      void listSavedCharacters()
        .then((rows) => {
          if (alive) setList(rows)
        })
        .catch(() => {
          if (alive) setList([])
        })
    }
    load()
    const off = subscribeSavedCharacters(load)
    return () => {
      alive = false
      off()
    }
  }, [])
  if (list === null) return <SkeletonRows rows={2} label={T.common.loading} />
  if (list.length === 0) {
    return (
      <EmptyState title={T.source.savedEmpty} icon={UsersRound} testid="m-create-saved-empty">
        {T.source.savedEmptyText}
      </EmptyState>
    )
  }
  const use = async (c: SavedCharacter) => {
    setBusy(c.id)
    try {
      const refs = []
      for (const [i, photo] of c.photos.slice(0, MAX_STORED_REFERENCES + 1).entries()) refs.push(await loadPhoneImageFromBlob(photo, `${c.name}-${i + 1}.jpg`))
      if (refs.length === 0) return
      takeImageAsSource(refs[0])
      useCreateStore.getState().setReferences(refs.slice(1))
      onDone()
    } catch (err) {
      toast(fileProblemText(err), { tone: 'error', testid: 'create-saved-failed' })
    } finally {
      setBusy(null)
    }
  }
  const remove = async (c: SavedCharacter) => {
    const yes = await nav.confirm({ title: T.source.savedDeleteTitle(c.name), text: T.source.savedDeleteText, confirmLabel: T.gal.delete, tone: 'danger', testid: 'create-saved-delete' })
    if (yes) await deleteSavedCharacter(c.id)
  }
  return (
    <ListGroup>
      {list.map((c) => (
        <Row
          key={c.id}
          icon={UsersRound}
          title={c.name}
          subtitle={busy === c.id ? T.file.loading : T.source.savedPhotos(c.photos.length)}
          chevron={false}
          disabled={busy !== null}
          onPress={() => void use(c)}
          trailing={<IconButton icon={Trash2} label={T.source.savedDelete(c.name)} onPress={() => void remove(c)} testid="m-create-saved-delete" />}
          testid="m-create-saved-row"
        />
      ))}
    </ListGroup>
  )
}

export default function SourceSheet() {
  const { sub, pushSub } = useSheet()
  // A photo is decoded before this sheet closes. By then another sheet may be on top.
  const close = useCloseOwnSheet()
  const tool = useCreateStore((s) => s.intent())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const facts = toolFacts(tool)
  const takesSource = toolTakesPhoto(tool)
  const model = useCreateFacts().model

  if (sub === 'saved') {
    return (
      <Sheet title={T.source.savedTitle}>
        <SavedCharacters onDone={close} />
      </Sheet>
    )
  }

  const take = async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)
    setProblem(null)
    const result = await addSourceFiles(files)
    setBusy(false)
    if (!result.ok) {
      setProblem(result.message || T.file.undecodable)
      return
    }
    if (result.batch > 1) toast(result.leftOut > 0 ? T.source.batchLeftOut(result.batch) : T.source.batchStarted(result.batch), { testid: 'create-batch-started' })
    else if (result.skipped > 0) toast(T.file.skipped(result.skipped), { testid: 'create-files-skipped' })
    close()
  }

  const takeVideo = async () => {
    setBusy(true)
    setProblem(null)
    const out = await pickVideoFor3d(threeDModelFacts(model.studio ? model.id : undefined).maxViews)
    setBusy(false)
    if (out.status === 'failed') setProblem(out.message)
    else if (out.status === 'ok') close()
  }

  return (
    <Sheet title={T.source.title}>
      {!takesSource ? <p className="m-cap m-k-pad">{T.source.switchesToEdit}</p> : null}
      {busy ? (
        <div className="m-k-center" data-testid="m-create-source-busy">
          <Progress label={T.file.loading} detail={T.file.loading} />
        </div>
      ) : null}
      {problem ? (
        <div className="m-k-sec">
          <Notice variant="error" testid="m-create-source-error">
            {problem}
          </Notice>
        </div>
      ) : null}
      <ListGroup>
        <Row
          icon={Camera}
          title={T.source.take}
          subtitle={T.source.takeSub}
          chevron={false}
          disabled={busy}
          onPress={() => void takePhoto().then((p) => take(p ? [p.file] : []))}
          risk="sensor" testid="m-create-source-take"
          el="K5.1"
        />
        <Row
          icon={Images}
          title={T.source.library}
          subtitle={facts.batch || !takesSource ? T.source.libraryBatchSub : T.source.librarySub}
          chevron={false}
          disabled={busy}
          onPress={() => void pickPhotos({ multiple: facts.batch || !takesSource }).then((p) => take(p.map((x) => x.file)))}
          risk="sensor" testid="m-create-source-library"
          el="K5.2"
        />
        <Row
          icon={FolderOpen}
          title={T.source.file}
          subtitle={T.source.fileSub}
          chevron={false}
          disabled={busy}
          onPress={() => void pickFiles({ accept: 'image/*,.heic,.heif' }).then((p) => take(p.map((x) => x.file)))}
          testid="m-create-source-file"
          el="K5.3"
        />
        {tool === '3d' ? (
          <Row icon={Film} title={T.source.video} subtitle={T.source.videoSub} chevron={false} disabled={busy} onPress={() => void takeVideo()} risk="sensor" testid="m-create-source-video" />
        ) : null}
        <Row icon={LayoutGrid} title={T.source.fromGallery} subtitle={T.source.fromGallerySub} disabled={busy} onPress={() => openGalleryPicker('source')} testid="m-create-source-gallery" el="K5.4" />
        <Row icon={UsersRound} title={T.source.saved} subtitle={T.source.savedSub} disabled={busy} onPress={() => pushSub('saved')} testid="m-create-source-saved" el="K5.5" />
      </ListGroup>
    </Sheet>
  )
}
