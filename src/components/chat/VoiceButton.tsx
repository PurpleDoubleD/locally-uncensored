import { motion } from "framer-motion"
import { Mic, MicOff, Loader2 } from "lucide-react"
import { useVoice } from "../../hooks/useVoice"

interface Props {
  onTranscript: (text: string) => void
  onRecordingChange?: (isRecording: boolean) => void
  disabled?: boolean
}

export function VoiceButton({ onTranscript, onRecordingChange, disabled }: Props) {
  const { isRecording, isTranscribing, sttSupported, startRecording, stopRecording } = useVoice()

  const handleClick = async () => {
    if (disabled || isTranscribing) return

    if (isRecording) {
      onRecordingChange?.(false)
      const transcript = await stopRecording()
      if (transcript.trim()) {
        onTranscript(transcript.trim())
      }
    } else {
      onRecordingChange?.(true)
      await startRecording()
    }
  }

  if (!sttSupported) {
    return (
      <div className="relative group/mic">
        <button
          disabled
          className="p-1.5 rounded-lg text-gray-300 dark:text-gray-600 cursor-not-allowed shrink-0"
          aria-label="Microphone unavailable"
        >
          <MicOff size={14} />
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 dark:bg-gray-700 text-white text-[0.6rem] rounded whitespace-nowrap opacity-0 group-hover/mic:opacity-100 transition-opacity pointer-events-none">
          Speech recognition not available
        </div>
      </div>
    )
  }

  // Transcribing state — show spinner
  if (isTranscribing) {
    return (
      <motion.button
        disabled
        className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-500/20 border border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400 shrink-0 relative"
        aria-label="Transcribing audio"
      >
        <Loader2 size={14} className="animate-spin" />
      </motion.button>
    )
  }

  return (
    <motion.button
      onClick={handleClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg transition-all shrink-0 relative ${
        isRecording
          ? "bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/40 text-red-600 dark:text-red-400"
          : "hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
      data-voice-button
      whileTap={{ scale: 0.9 }}
      aria-label={isRecording ? "Stop recording" : "Start voice input"}
    >
      {isRecording && (
        <motion.span
          className="absolute inset-0 rounded-lg border-2 border-red-500 dark:border-red-400"
          animate={{ scale: [1, 1.15, 1], opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <Mic size={14} />
    </motion.button>
  )
}
