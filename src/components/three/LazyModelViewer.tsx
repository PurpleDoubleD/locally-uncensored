// The 3D view, fetched on first use: three and its loaders stay out of the
// bundle the app starts with.
import { Suspense, lazy } from 'react'
import { Box } from 'lucide-react'
import type { ModelViewerProps } from './ModelViewer'

const ModelViewer = lazy(() => import('./ModelViewer'))

export function LazyModelViewer(props: ModelViewerProps) {
  return (
    <Suspense
      fallback={
        <div className="flex w-full h-full min-h-[280px] items-center justify-center rounded-[var(--radius-panel)] border border-white/[0.06]">
          <Box size={28} className="text-gray-500 animate-pulse" />
        </div>
      }
    >
      <ModelViewer {...props} />
    </Suspense>
  )
}
