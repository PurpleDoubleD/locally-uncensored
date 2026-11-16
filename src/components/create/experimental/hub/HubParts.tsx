// The small parts the Character area is built from (sketches v2): rows on
// the surface with a hairline under them, a round picture, a text choice with
// a small arrow. No box around a field; the one framed part of the tab is
// the prompt window under the area, the same as in every tab.

import { createContext, useContext, useRef, type ReactNode } from 'react'
import { ArrowRight, Plus } from 'lucide-react'
import { hubInitial, type HubCharacter } from '../../../../lib/create/character-hub'
import { Select, type SelectOption } from '../../ui/Select'
import { cn } from '../../ui/cn'

/** The characters of step 1, shared with the pickers in the panels so the
 *  list is asked once. */
export const HubCharactersContext = createContext<HubCharacter[]>([])

export function useHubList(): HubCharacter[] {
  return useContext(HubCharactersContext)
}

/** A round picture, or the initial on the soft accent where there is none. */
export function HubAvatar({ name, image, size = 26 }: { name: string; image: string | null | undefined; size?: number }) {
  if (image) {
    return (
      <span
        aria-hidden
        className="inline-block shrink-0 rounded-full bg-gray-200 bg-cover"
        style={{ width: size, height: size, backgroundImage: `url("${image}")`, backgroundPosition: '50% 12%' }}
      />
    )
  }
  return (
    <span
      aria-hidden
      className="hub-soft hub-acc inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {hubInitial(name)}
    </span>
  )
}

/** One line of a panel: 40 px (46 rendered), a hairline under it. */
export function HubLine({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('hub-line flex min-h-10 items-center gap-2.5 border-b hub-fs-14', className)} {...rest}>
      {children}
    </div>
  )
}

const PHOTO = '__photo'

/** "→ Bean ▾": the character a person or the portrait becomes. The list is
 *  the characters with a picture, then "Upload a photo…", which takes any
 *  photo without saving it. */
export function CharacterPick({ name, image, onCharacter, onPhoto, label, disabled, inputData }: {
  name: string | null
  image: string | null
  onCharacter: (c: HubCharacter) => void
  onPhoto: (file: File) => void
  /** For assistive tech: "Character for person 1". */
  label: string
  disabled?: boolean
  /** Data attributes for the hidden file field (tests find it by them). */
  inputData?: Record<string, string>
}) {
  const list = useHubList().filter((c) => !!c.image || (c.photos?.length ?? 0) > 0)
  const file = useRef<HTMLInputElement>(null)
  const picked = list.find((c) => c.name === name)
  const current = name ?? (image ? 'Photo' : null)
  const options: SelectOption[] = [
    ...list.map((c) => ({ value: c.key, label: c.name, sublabel: c.meta, lead: <HubAvatar name={c.name} image={c.image} size={18} /> })),
    { value: PHOTO, label: 'Upload a photo…', lead: <Plus size={14} className="hub-dim" /> },
  ]
  // The closed field shows what is set; a photo that is not a listed
  // character shows as "Photo" with its own picture.
  if (current && !picked) options.unshift({ value: '__current', label: current, lead: <HubAvatar name={current} image={image} size={20} /> })
  return (
    <span className="flex shrink-0 items-center gap-2.5">
      <ArrowRight size={13} className="hub-dim" aria-hidden />
      <input
        ref={file}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`${label}: upload a photo`}
        {...inputData}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = '' }}
      />
      {current || list.length > 0 ? (
        <Select
          variant="text"
          textClassName="w-[92px] hub-fs-14 font-medium"
          ariaLabel={label}
          align="right"
          placeholder="Choose"
          value={picked?.key ?? (current ? '__current' : '')}
          options={options.map((o) => (o.value === picked?.key ? { ...o, lead: <HubAvatar name={o.label} image={picked?.image} size={20} /> } : o))}
          onChange={(v) => {
            if (disabled) return
            if (v === PHOTO) { file.current?.click(); return }
            const c = list.find((x) => x.key === v)
            if (c) onCharacter(c)
          }}
        />
      ) : (
        <button type="button" aria-label={label} disabled={disabled} onClick={() => file.current?.click()} className="hub-acc w-[92px] text-left hub-fs-14">
          Add a photo
        </button>
      )}
    </span>
  )
}

/** A flat upload line: an icon and a sentence, the whole line takes the file. */
export function UploadLine({ icon, label, accept, onFile, note }: {
  icon: ReactNode
  label: string
  accept: string
  onFile: (file: File) => void
  note?: ReactNode
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <HubLine className="hub-hover -mx-2 cursor-pointer rounded-sm px-2" onClick={() => ref.current?.click()} role="button" aria-label={label}>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }}
      />
      <span className="hub-muted">{icon}</span>
      <span className="hub-text">{label}</span>
      {note && <span className="hub-dim ml-auto hub-fs-125">{note}</span>}
    </HubLine>
  )
}

/** A switch as a row (one click swap, sketch c2): the name, a grey line what
 *  it does, the switch at the right. A hairline under it, no box. */
export function HubSwitch({ title, line, on, onChange, disabled, testId }: {
  title: string
  line: string
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <div className="hub-line flex min-h-12 items-center gap-4 border-b py-1.5" data-hub-switch={testId}>
      <span className="min-w-0 flex-1">
        <span className="hub-text block hub-fs-14">{title}</span>
        <span className="hub-dim block hub-fs-125">{line}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn(
          'relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-40',
          on ? 'bg-[var(--hub-acc)]' : 'bg-[var(--hub-edge)]',
        )}
      >
        <span className={cn('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left]', on ? 'left-[14px]' : 'left-[2px]')} />
      </button>
    </div>
  )
}
