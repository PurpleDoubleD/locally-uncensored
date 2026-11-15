// C41's "Rename and note" dialog, for a LoRA and (W33) for an image or video
// model and a finished download. It renames the name LU shows; the file
// keeps its own name, so saved settings, workflows and the catalog's install
// check still find it.
import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { useLoraNotesStore } from '../../stores/loraNotesStore'

export type RenameKind = 'lora' | 'model'

/** What the dialog says the name is for. */
export function renameHint(kind: RenameKind): string {
  return kind === 'lora'
    ? 'The name is how LU shows this LoRA, here and in the LoRA stack of Create.'
    : 'The name is how LU shows this model in the Models tab and in the download list.'
}

export function RenameNoteDialog({ name, kind, onClose }: { name: string | null; kind: RenameKind; onClose: () => void }) {
  return (
    <Modal open={!!name} onClose={onClose} title="Rename and note">
      {/* Keyed by the file, so each opening starts from what is stored for it. */}
      {name && <RenameForm key={name} name={name} kind={kind} onClose={onClose} />}
    </Modal>
  )
}

function RenameForm({ name, kind, onClose }: { name: string; kind: RenameKind; onClose: () => void }) {
  const [label, setLabel] = useState(() => useLoraNotesStore.getState().notes[name]?.label ?? '')
  const [note, setNote] = useState(() => useLoraNotesStore.getState().notes[name]?.note ?? '')
  return (
    <form
      className="space-y-3"
      data-testid="lora-edit"
      onSubmit={(e) => {
        e.preventDefault()
        useLoraNotesStore.getState().setNote(name, { label, note })
        onClose()
      }}
    >
      <p className="t-micro text-gray-500 dark:text-gray-400">
        {renameHint(kind)} The file keeps its own name, <span className="font-mono break-all">{name}</span>, so saved settings and workflows still find it.
      </p>
      <label className="block t-label text-gray-700 dark:text-gray-200">
        Name
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={name.replace(/\.(safetensors|gguf|ckpt|pt|pth|bin)$/i, '')}
          maxLength={120}
          className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white"
          data-testid="lora-edit-name"
        />
      </label>
      <label className="block t-label text-gray-700 dark:text-gray-200">
        Note
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={kind === 'lora' ? 'Trigger words, a strength that works, what it is good for…' : 'What it is good for, settings that work…'}
          rows={4}
          maxLength={2000}
          className="mt-1 w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white"
          data-testid="lora-edit-note"
        />
      </label>
      <ModalActions>
        <ModalButton variant="quiet" onClick={onClose}>Cancel</ModalButton>
        <ModalButton variant="primary" type="submit" data-testid="lora-edit-save">Save</ModalButton>
      </ModalActions>
    </form>
  )
}
