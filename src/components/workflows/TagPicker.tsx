import type { WorkflowTag } from '../../types/workflows'
import { cn } from '../create/ui/cn'

interface Props {
  tags: WorkflowTag[]
  selectedIds: string[]
  onChange: (tagIds: string[]) => void
  emptyLabel?: string
}

export function TagPicker({
  tags,
  selectedIds,
  onChange,
  emptyLabel = 'Create a tag first',
}: Props) {
  const selected = new Set(selectedIds)

  const toggleTag = (tagId: string) => {
    if (selected.has(tagId)) {
      onChange(selectedIds.filter((id) => id !== tagId))
      return
    }
    onChange([...selectedIds, tagId])
  }

  if (tags.length === 0) {
    return <p className="t-body text-gray-500">{emptyLabel}</p>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const active = selected.has(tag.id)
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggleTag(tag.id)}
            className={cn(
              't-control rounded-full border px-2.5 py-1 transition-colors',
              active
                ? 'border-lu-accent/50 bg-lu-accent-soft text-lu-accent'
                : 'border-white/[0.08] bg-white/[0.04] text-gray-500 hover:border-white/20 hover:text-gray-200',
            )}
          >
            {tag.name}
          </button>
        )
      })}
    </div>
  )
}
