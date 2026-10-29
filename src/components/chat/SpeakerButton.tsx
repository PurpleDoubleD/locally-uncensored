import { useState } from "react"
import { Volume2, VolumeX } from "lucide-react"
import { useVoice } from "../../hooks/useVoice"
import { useVoiceStore } from "../../stores/voiceStore"
import { HINWEIS_TEXT } from "../../lib/hinweis"

interface Props {
  text: string
}

export function SpeakerButton({ text }: Props) {
  const { isSpeaking, ttsSupported, ttsAvailable, ttsExternalReady, ttsEnabled, speakTextStreaming, stopSpeaking } = useVoice()
  // Jaeger B, B11: when the external voice fails, read-aloud switches to the
  // system voice. The bubble whose button was pressed says so, with the
  // error, instead of speaking in another voice without a word.
  const fallbackReason = useVoiceStore((s) => (s.ttsMode === "external" ? s.ttsFallbackReason : null))
  const [pressed, setPressed] = useState(false)

  // Show the read-aloud button only when the feature is on AND some TTS engine
  // is usable: an external HTTP engine (#58), local neural Piper, or the
  // browser's system voices as fallback. Availability is reactive: the boot
  // probe (App.tsx) and the Settings install both push it into the store, so
  // this lights up without a per-message probe.
  if (!ttsEnabled || (!ttsExternalReady && !ttsAvailable && !ttsSupported)) return null

  const handleClick = () => {
    if (isSpeaking) {
      stopSpeaking()
    } else {
      setPressed(true)
      speakTextStreaming(text)
    }
  }

  return (
    <>
    <button
      onClick={handleClick}
      className={
        "p-1 rounded-md transition-colors " +
        (isSpeaking
          ? "text-blue-500 dark:text-blue-400 bg-blue-500/10"
          : "text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10")
      }
      title={isSpeaking ? "Stop speaking" : "Read aloud"}
      aria-label={isSpeaking ? "Stop speaking" : "Read aloud"}
    >
      {isSpeaking ? <VolumeX size={12} /> : <Volume2 size={12} />}
    </button>
    {pressed && fallbackReason && (
      <span role="status" className={`t-micro leading-snug max-w-[18rem] ${HINWEIS_TEXT.fehler}`}>
        {fallbackReason}
      </span>
    )}
    </>
  )
}
