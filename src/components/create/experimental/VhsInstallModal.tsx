import { Download } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { Modal } from '../../ui/Modal'

/**
 * Bug A (v2.4.5) + #72 (bob): one-click install of VHS_VideoCombine so video
 * generation produces actual .mp4 files instead of animated .webp fallbacks.
 * Pops when useCreate detects webpOnly capability and sets vhsInstallPrompt
 * in the store; resolves with the user's choice and useCreate continues /
 * cancels.
 */
export function VhsInstallModal() {
  const vhsInstallPrompt = useCreateStore((s) => s.vhsInstallPrompt)
  const open = vhsInstallPrompt !== null

  const choose = (choice: 'install' | 'webp' | 'cancel') => {
    if (vhsInstallPrompt) vhsInstallPrompt(choice)
  }

  return (
    <Modal open={open} onClose={() => choose('cancel')} title="Install MP4 support?">
      <div className="space-y-4 text-sm text-gray-200">
        {/* Der Grund stand frueher in einem gelben Kasten mit Rahmen, Fuellung
            und Warnsymbol, mitten im Dialog, der ihn ohnehin schon stellt. Der
            Rahmen war der Dialog, die Fuellung hat nichts getragen, und das
            Gelb hat aus einer Feststellung eine Stoerung gemacht. Jetzt zwei
            Zeilen Text: die Feststellung und ihre Folge. Die Regel dazu steht
            in lib/hinweis.ts. */}
        <div className="space-y-1.5">
          <p className="font-medium text-[13px]">
            Your ComfyUI doesn't have <code className="px-1 py-0.5 rounded bg-black/40 font-mono text-[11px]">VHS_VideoCombine</code>
          </p>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Without it, video generation falls back to <code className="font-mono text-[10px] bg-black/40 px-1 rounded">SaveAnimatedWEBP</code> and produces an animated <code className="font-mono text-[10px] bg-black/40 px-1 rounded">.webp</code> file instead of a real <code className="font-mono text-[10px] bg-black/40 px-1 rounded">.mp4</code> video.
          </p>
        </div>

        <div className="text-[11px] text-gray-400 leading-relaxed">
          The installer runs <code className="font-mono bg-white/5 px-1 rounded">git clone</code> on{' '}
          <a
            href="https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Kosinkadink/ComfyUI-VideoHelperSuite
          </a>
          {' '}(~5 MB) into your <code className="font-mono bg-white/5 px-1 rounded">ComfyUI/custom_nodes/</code> folder, runs <code className="font-mono bg-white/5 px-1 rounded">pip install</code> for its requirements, and restarts ComfyUI. Takes about 30 seconds.
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <button
            onClick={() => choose('install')}
            className="w-full px-4 py-2 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-200 text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Download size={14} />
            Install VHS_VideoCombine + continue
          </button>
          <button
            onClick={() => choose('webp')}
            className="w-full px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 text-xs font-medium transition-colors"
          >
            Continue anyway with animated .webp
          </button>
          <button
            onClick={() => choose('cancel')}
            className="w-full px-4 py-1.5 rounded-lg hover:bg-white/5 text-gray-500 hover:text-gray-300 text-xs transition-colors"
          >
            Cancel generation
          </button>
        </div>
      </div>
    </Modal>
  )
}
