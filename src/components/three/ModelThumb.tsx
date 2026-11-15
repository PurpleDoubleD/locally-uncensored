// The gallery tile of a 3D model: the still the 3D view drew of it, with a
// small cube in the corner. Before a still exists the tile shows the cube and
// the entry's name, like the audio tile.
import { useEffect, useState } from 'react'
import { Box } from 'lucide-react'
import type { GalleryItem } from '../../stores/createStore'
import { galleryLabel } from '../../lib/render/gallery-label'
import { onPoster, readPoster } from '../../lib/three/mesh-poster'

export function usePoster(id: string): string | null {
  const [poster, setPoster] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => void readPoster(id).then((p) => { if (alive) setPoster(p) })
    read()
    const off = onPoster((changed) => { if (changed === id) read() })
    return () => { alive = false; off() }
  }, [id])
  return poster
}

export function ModelThumb({ item, small }: { item: GalleryItem; small?: boolean }) {
  const poster = usePoster(item.id)
  if (!poster) {
    return (
      <span className="w-full h-full flex flex-col items-center justify-center gap-1 bg-white/[0.03] text-gray-400 p-1" data-testid="thumb-3d">
        <Box size={16} />
        {!small && <span className="t-label truncate max-w-full px-1">{galleryLabel(item)}</span>}
      </span>
    )
  }
  return (
    <>
      <img src={poster} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" data-testid="thumb-3d" />
      <span className="absolute bottom-1 right-1 rounded bg-black/55 p-0.5"><Box size={12} className="text-white/90" /></span>
    </>
  )
}
