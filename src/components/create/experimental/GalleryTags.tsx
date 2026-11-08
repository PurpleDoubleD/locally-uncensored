import { useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import { Modal } from '../../ui/Modal'
import { ModalActions, ModalButton } from '../../ui/ModalActions'
import { useCreateStore } from '../../../stores/createStore'
import { TAG_MAX, cleanTag, hiddenCount, tagCounts } from '../../../lib/gallery-tags'
import { Select, type SelectOption } from '../ui/Select'
import { cn } from '../ui/cn'

// Hide and tags in the gallery (D27, 3.1.0). Labels inside the app, like
// folders: hiding keeps the file, the prompt and the folder (lib/gallery-tags.ts).

const ALL_TAGS = '__all_tags'

const FIELD =
  'h-[var(--control-h-md)] px-2.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus:border-white/20 outline-none t-control text-gray-100'

/** Under the folder filter: the tag filter (once a tag exists) and the way into
 *  the hidden entries (once one is hidden). Nothing shows while neither exists. */
export function TagFilter() {
  const gallery = useCreateStore((s) => s.gallery)
  const tagOpen = useCreateStore((s) => s.galleryTagOpen)
  const setTagOpen = useCreateStore((s) => s.setGalleryTagOpen)
  const showHidden = useCreateStore((s) => s.galleryShowHidden)
  const setShowHidden = useCreateStore((s) => s.setGalleryShowHidden)
  const tags = tagCounts(gallery)
  const hidden = hiddenCount(gallery)
  if (tags.length === 0 && hidden === 0 && !showHidden && tagOpen === null) return null
  const options: SelectOption[] = [
    { value: ALL_TAGS, label: 'All tags' },
    ...tags.map((t) => ({ value: t.tag, label: `#${t.tag} (${t.count})` })),
  ]
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2 shrink-0" data-testid="gallery-tag-filter">
      {tags.length > 0 && (
        <Select
          size="sm"
          className="flex-1 min-w-0"
          ariaLabel="Show tag"
          options={options}
          value={tagOpen ?? ALL_TAGS}
          onChange={(v) => setTagOpen(v === ALL_TAGS ? null : v)}
        />
      )}
      {(hidden > 0 || showHidden) && (
        <button
          type="button"
          onClick={() => setShowHidden(!showHidden)}
          aria-pressed={showHidden}
          title={showHidden ? 'Back to the gallery' : 'Show the hidden items'}
          className={cn(
            'flex items-center justify-center gap-1 h-[var(--control-h-sm)] px-1.5 rounded t-label transition-colors',
            showHidden ? 'bg-white/10 text-gray-200' : 'text-gray-500 hover:text-gray-200 hover:bg-white/5',
            tags.length === 0 && 'ml-auto',
          )}
        >
          {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
          <span>{showHidden ? 'Hidden' : `Hidden (${hidden})`}</span>
        </button>
      )}
    </div>
  )
}

/** The tags of one or more entries: add one to all of them, take one off all of them. */
export function TagsModal({ ids, onClose }: { ids: readonly string[]; onClose: () => void }) {
  return (
    <Modal open={ids.length > 0} onClose={onClose} title={ids.length > 1 ? `Tags for ${ids.length} items` : 'Tags'} maxWidth="max-w-md">
      <TagsEditor ids={ids} />
      <ModalActions>
        <ModalButton variant="primary" onClick={onClose}>Done</ModalButton>
      </ModalActions>
    </Modal>
  )
}

function TagsEditor({ ids }: { ids: readonly string[] }) {
  const gallery = useCreateStore((s) => s.gallery)
  const tag = useCreateStore((s) => s.tagGalleryItems)
  const untag = useCreateStore((s) => s.untagGalleryItems)
  const [text, setText] = useState('')
  const pick = new Set(ids)
  const picked = gallery.filter((g) => pick.has(g.id))
  const onThese = tagCounts(picked)
  const known = new Set(onThese.map((t) => t.tag.toLocaleLowerCase()))
  const others = tagCounts(gallery).filter((t) => !known.has(t.tag.toLocaleLowerCase())).slice(0, 12)
  const add = (raw: string) => {
    if (!cleanTag(raw)) return
    tag(ids, raw)
    setText('')
  }
  return (
    <div className="flex flex-col gap-3" data-testid="gallery-tags">
      <p className="t-body text-gray-500">Tags only sort the gallery. Pick one above the gallery to see just those items.</p>
      {onThese.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags on these items">
          {onThese.map((t) => (
            <li key={t.tag} className="flex items-center gap-1 pl-2 pr-1 h-6 rounded-full bg-white/[0.07] t-label text-gray-200">
              #{t.tag}
              {picked.length > 1 && t.count < picked.length && <span className="text-gray-500">{t.count}/{picked.length}</span>}
              <button
                type="button"
                onClick={() => untag(ids, t.tag)}
                title={`Remove #${t.tag}`} aria-label={`Remove tag ${t.tag}`}
                className="w-4 h-4 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-100 hover:bg-white/10"
              >
                <X size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          value={text}
          maxLength={TAG_MAX + 1}
          placeholder="New tag"
          aria-label="New tag"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(text) }}
          className={`flex-1 min-w-0 ${FIELD}`}
        />
        <ModalButton onClick={() => add(text)} disabled={!cleanTag(text)}>Add</ModalButton>
      </div>
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Tags in use">
          {others.map((t) => (
            <button
              key={t.tag}
              type="button"
              onClick={() => add(t.tag)}
              className="px-2 h-6 rounded-full border border-white/[0.08] t-label text-gray-400 hover:text-gray-100 hover:bg-white/5"
            >
              #{t.tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
