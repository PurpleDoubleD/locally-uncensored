import { useEffect } from "react"
import { motion } from "framer-motion"
import { Mic, MicOff } from "lucide-react"
import { useVoice } from "../../hooks/useVoice"

interface Props {
  onTranscript: (text: string) => void
  onInterimTranscript?: (text: string) => void
  onRecordingChange?: (isRecording: boolean) => void
  onStopRegistered?: (stopFn: () => Promise<string>) => void
  disabled?: boolean
}

export function VoiceButton({ onTranscript, onInterimTranscript, onRecordingChange, onStopRegistered, disabled }: Props) {
  const { isRecording, sttSupported, startRecording, stopRecording } = useVoice()

  // Register stop function whenever recording state changes
  useEffect(() => {
    if (isRecording && onStopRegistered) {
      onStopRegistered(async () => {
        const transcript = await stopRecording()
        onRecordingChange?.(false)
        if (transcript.trim()) {
          onTranscript(transcript.trim())
        }
        return transcript
      })
    }
  }, [isRecording, onStopRegistered, stopRecording, onRecordingChange, onTranscript])

  const handleClick = async () => {
    if (disabled) return

    if (isRecording) {
      const transcript = await stopRecording()
      onRecordingChange?.(false)
      if (transcript.trim()) {
        onTranscript(transcript.trim())
      }
    } else {
      // Notify parent BEFORE starting (so UI updates immediately)
      onRecordingChange?.(true)
      await startRecording(onInterimTranscript)
    }
  }

  if (!sttSupported) {
    return (
      <div className="relative group/mic">
        <button
          disabled
          className="p-2 rounded-lg text-gray-300 dark:text-gray-600 cursor-not-allowed shrink-0"
        >
          <MicOff size={15} />
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 dark:bg-gray-700 text-white text-[0.6rem] rounded whitespace-nowrap opacity-0 group-hover/mic:opacity-100 transition-opacity pointer-events-none">
          Speech recognition not supported
        </div>
      </div>
    )
  }

  return (
    <motion.button
      onClick={handleClick}
      disabled={disabled}
      className={`p-2 rounded-lg transition-all shrink-0 relative ${
        isRecording
          ? "bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/40 text-red-600 dark:text-red-400"
          : "hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
      data-voice-button
      whileTap={{ scale: 0.9 }}
    >
      {isRecording && (
        <motion.span
          className="absolute inset-0 rounded-lg border-2 border-red-500 dark:border-red-400"
          animate={{ scale: [1, 1.15, 1], opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <Mic size={15} />
    </motion.button>
  )
}
