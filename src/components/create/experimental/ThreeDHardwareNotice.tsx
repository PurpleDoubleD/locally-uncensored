// The line of the 3D tab for a PC whose card does not fit TRELLIS.2 (under
// 12 GB, or ComfyUI on the processor), lib/three/three-d-hardware.ts. It
// stands with the other quiet lines above the stage, so it is there before
// the setup card and before a run alike. A hint, not a lock: the setup and
// the Create button stay as they are. Not on a Mac.
import { Cpu } from 'lucide-react'
import { isMlxImageHost } from '../../../api/mlx-image'
import { reportCloudGate } from '../../../api/funnel'
import { useGraphicsCardGb } from '../../../hooks/useGraphicsMemory'
import { THREE_D_USE_CLOUD, threeDHardwareLine } from '../../../lib/three/three-d-hardware'
import { useCreateStore } from '../../../stores/createStore'
import { useUIStore } from '../../../stores/uiStore'
import { useCloudOfferAllowed } from '../../cloud/CloudOffer'
import { Hinweis } from '../../ui/Hinweis'
import { useCreateExp } from './CreateContext'

export function ThreeDHardwareNotice() {
  const intent = useCreateStore((s) => s.intent())
  const backend = useCreateStore((s) => s.backend)
  const setBackend = useCreateStore((s) => s.setBackend)
  const setCloudGateOpen = useUIStore((s) => s.setCloudGateOpen)
  const cardGb = useGraphicsCardGb()
  const { comfyOnCpu, cloudAvailable } = useCreateExp()
  const cloudAllowed = useCloudOfferAllowed()
  if (intent !== '3d' || backend !== 'local' || isMlxImageHost()) return null
  const line = threeDHardwareLine({ cardGb, comfyOnCpu })
  if (!line) return null
  const toCloud = () => {
    // Signed in: the same tab in cloud mode. Otherwise the plans, as the
    // other cloud offers in Create do.
    if (cloudAvailable) {
      setBackend('cloud')
      return
    }
    reportCloudGate('cloud_offer_click')
    setCloudGateOpen(true, 'cloud-offer')
  }
  return (
    <Hinweis icon={<Cpu size={12} className="shrink-0 mt-px" />} className="px-4 py-2 shrink-0">
      <span data-testid="three-d-hardware">{line}</span>
      {cloudAllowed && (
        <>
          {' '}
          <button
            type="button"
            onClick={toCloud}
            data-testid="three-d-hardware-cloud"
            className="inline font-medium text-lu-cloud dark:text-lu-cloud-lift hover:underline underline-offset-2"
          >
            {THREE_D_USE_CLOUD}
          </button>
        </>
      )}
    </Hinweis>
  )
}
