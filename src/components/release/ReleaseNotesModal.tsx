// "What is new" sheet, shown once after an update (B4, David 2026-08-04).
// Same shape as CloudTeaserModal: 360 px sheet, #232323, rounded-2xl, a short
// animated stage on top, framer-motion in and out, backdrop and X both close.
// Dismissing stamps the version, so it never comes back for this build.

import { useState } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Sparkles, ChevronDown } from 'lucide-react'
import { version as currentVersion } from '../../../package.json'
import { useSettingsStore } from '../../stores/settingsStore'
import { useReleaseNotesStore, shouldShowReleaseNotes } from '../../stores/releaseNotesStore'
import { releaseNoteFor } from '../../lib/release-notes'

export function ReleaseNotesModal() {
  const lastNotesVersion = useReleaseNotesStore((s) => s.lastNotesVersion)
  const markNotesSeen = useReleaseNotesStore((s) => s.markNotesSeen)
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone)
  const [expanded, setExpanded] = useState(false)

  const open = shouldShowReleaseNotes(currentVersion, lastNotesVersion, onboardingDone)
  const note = releaseNoteFor(currentVersion)
  const close = () => markNotesSeen(currentVersion)
  useDismissOnEscape(open && !!note, close)

  return (
    <AnimatePresence>
      {open && note && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="w-[360px] max-w-[92vw] rounded-2xl bg-[#232323] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden"
          >
            <div className="relative h-[130px] bg-[#1b1b1b] border-b border-white/[0.06] overflow-hidden">
              <UpdateDemo version={note.version} />
              <button
                onClick={close}
                className="absolute top-2 right-2 p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-white/10 transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-violet-300" />
                <h3 className="text-[0.85rem] font-semibold text-white">What is new</h3>
                <span className="ml-auto text-[0.55rem] font-medium uppercase tracking-widest text-violet-300/80">
                  {note.version}
                </span>
              </div>
              <p className="text-[0.7rem] leading-relaxed text-gray-300">{note.headline}</p>
              <ul className="space-y-1.5">
                {note.lines.map((line) => (
                  <li key={line} className="flex gap-2 text-[0.62rem] leading-relaxed text-gray-500">
                    <span className="mt-[0.35rem] w-1 h-1 rounded-full bg-violet-300/70 shrink-0" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              {note.details && note.details.length > 0 && (
                <>
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-1 text-[0.62rem] text-violet-300/90 hover:text-violet-200 transition-colors"
                    aria-expanded={expanded}
                  >
                    <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    {expanded ? 'Hide details' : 'Show all changes'}
                  </button>
                  {expanded && (
                    <div className="space-y-3">
                      {note.details.map((section) => (
                        <div key={section.title} className="space-y-1.5">
                          <p className="text-[0.55rem] font-semibold uppercase tracking-widest text-gray-500">
                            {section.title}
                          </p>
                          <ul className="space-y-1">
                            {section.items.map((item) => (
                              <li key={item} className="flex gap-2 text-[0.6rem] leading-relaxed text-gray-500">
                                <span className="mt-[0.32rem] w-1 h-1 rounded-full bg-gray-600 shrink-0" />
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={close}
                  className="flex-1 flex items-center justify-center h-8 rounded-lg bg-white text-black text-[0.7rem] font-semibold hover:bg-gray-200 transition-colors"
                >
                  Got it
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Pure CSS/SVG, like the teaser demos: no media asset in the bundle. */
function UpdateDemo({ version }: { version: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <motion.div
        className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/50 to-sky-500/50 flex items-center justify-center"
        animate={{ scale: [0.94, 1.04, 0.94] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <span className="text-[0.7rem] font-mono font-semibold text-white/90">{version}</span>
      </motion.div>
    </div>
  )
}
