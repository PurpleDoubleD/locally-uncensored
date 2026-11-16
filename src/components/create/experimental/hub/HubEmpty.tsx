// The Character area with no character yet (David, 16.11.2026): the three
// steps and the one button, in the column over the prompt window. No
// pictures and nothing that moves; what a character can do stands in the
// row over the window (Image, Swap, Motion, Talk).

import { Plus } from 'lucide-react'
import { Button } from '../../ui/Button'

const STEPS = [
  { title: 'Add photos of one face', line: '4 to 30 photos, or frames from a video in your gallery.' },
  { title: 'Give it a name', line: 'Saved right away. Train it later for the best likeness.' },
  { title: 'Use it', line: 'Image, Swap, Motion and Talk. In Chat too.' },
]

export function HubEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="hub-empty scrollbar-thin" data-hub-step="who" data-hub-empty>
      <ol className="hub-line border-t">
        {STEPS.map((s, i) => (
          <li key={s.title} className="hub-line flex gap-4 border-b py-3">
            <span className="hub-dim w-3 shrink-0 pt-px hub-fs-13 tabular-nums">{i + 1}</span>
            <span className="min-w-0">
              <span className="hub-text block hub-fs-14 font-medium">{s.title}</span>
              <span className="hub-dim mt-0.5 block hub-fs-13">{s.line}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="pt-5">
        <span data-hub-create><Button variant="primary" size="lg" icon={Plus} onClick={onCreate}>Create a character</Button></span>
      </div>
    </div>
  )
}
