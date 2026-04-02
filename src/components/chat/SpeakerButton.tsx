import { Volume2, VolumeX } from "lucide-react"
import { useVoice } from "../../hooks/useVoice"

interface Props {
  text: string
}

export function SpeakerButton({ text }: Props) {
  const { isSpeaking, ttsSupported, speakTextStreaming, stopSpeaking } = useVoice()

  if (!ttsSupported) return null

  const handleClick = () => {
    if (isSpeaking) {
      stopSpeaking()
    } else {
      speakTextStreaming(text)
    }
  }

  return (
    <button
      onClick={handleClick}
      className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-all"
      title={isSpeaking ? "Stop speaking" : "Read aloud"}
      aria-label={isSpeaking ? "Stop speaking" : "Read aloud"}
    >
      {isSpeaking ? <VolumeX size={12} /> : <Volume2 size={12} />}
    </button>
  )
}
