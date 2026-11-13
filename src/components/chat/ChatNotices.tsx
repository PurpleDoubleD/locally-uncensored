/**
 * Der Platz, an dem die Zeilen aus dem Eingabefeld gelandet sind.
 *
 * Oben im Verlaufsbereich, nicht am Composer: 21.09.2026, mehrfach am
 * echten Windows-Bau, „NICHTS im prompt fenster!" Ein Toastsystem, in das
 * beliebige Stellen der App schreiben koennten, gibt es hier nicht, und dafuer
 * eins zu erfinden waere mehr Bauwerk als Befund. Also ein Platz, eine Form,
 * und jede Zeile mit Namen.
 *
 * Gezeichnet wird mit `<Hinweis>`, also in genau der Form, die `lib/hinweis.ts`
 * fuer Anmerkungen und Fehler vorschreibt: eine Zeile, kein Kasten, ruhiges
 * Grau oder Rot, und ein x, das sie wegnimmt.
 */
import { Binary, Bot, Download, FileText, FolderOpen, ImageOff, Images, Paperclip, Scissors } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { useChatNoticeStore, CONVERSATION_BOUND, type ChatNoticeId } from '../../stores/chatNoticeStore'
import { COMPOSER_MAX_W } from './composer-width'
import { useModelStore } from '../../stores/modelStore'
import { useImagePartOffer } from '../../hooks/useImagePartOffer'
import { AddImageInput } from '../models/AddImageInput'
import { displayModelName } from '../../api/providers'
import { IMAGE_INPUT_MISSING, IMAGE_INPUT_LOADED_WITHOUT } from '../../lib/image-part'

/** Das Symbol je Zeile. Keine eigene Farbe: die traegt der Ton. */
const ICON: Record<ChatNoticeId, typeof Paperclip> = {
  'document-belongs-in-docs': FileText,
  'model-cannot-see-images': ImageOff,
  'image-attach': Images,
  'file-attach': Paperclip,
  'binary-summary-only': Binary,
  'file-cut': Scissors,
  'agent-outside-workspace': FolderOpen,
  'agent-for-local-files': Bot,
  'create-save': Download,
}


interface Props {
  /** Die Dokumentenablage oeffnen, fuer die Zeile ueber ein angehaengtes
   *  Dokument. Fehlt sie, faellt der Knopf weg und der Satz bleibt wahr. */
  onAttachDocs?: () => void
  /** Wo gezeichnet wird. Im Code-Bereich fallen die Chat-Agent-Zeilen weg. */
  surface?: 'chat' | 'code'
}

export function ChatNotices({ onAttachDocs, surface = 'chat' }: Props) {
  const all = useChatNoticeStore((s) => s.notices)
  const dismiss = useChatNoticeStore((s) => s.dismiss)
  // Die Zeilen ueber den Agent-Knopf und seinen Ordner gelten im CHAT. Im
  // Code-Bereich gibt es diesen Knopf nicht (Gegenprobe 01.10.2026).
  // Dasselbe gilt fuer den Weg in die Dokumentenablage: die gibt es nur im Chat.
  const notices = surface === 'code'
    ? all.filter((n) => !CONVERSATION_BOUND.has(n.id) && n.id !== 'document-belongs-in-docs')
    : all

  if (notices.length === 0) return null

  return (
    <div data-testid="chat-notices" className={`w-full ${COMPOSER_MAX_W} mx-auto px-3 pt-1`}>
      {notices.map((n) => {
        const Icon = ICON[n.id]
        return (
          <Hinweis
            key={n.id}
            ton={n.ton}
            className="px-1"
            icon={<Icon size={11} className="shrink-0 mt-0.5" />}
            onDismiss={() => dismiss(n.id)}
          >
            {n.id === 'model-cannot-see-images' ? <BlindModelNotice text={n.text} /> : n.text}
            {n.id === 'document-belongs-in-docs' && onAttachDocs && (
              <button
                onClick={() => { dismiss(n.id); onAttachDocs() }}
                className="ml-1 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Open Documents
              </button>
            )}
          </Hinweis>
        )
      })}
    </div>
  )
}

/**
 * The line under a picture handed to a model that cannot see it.
 *
 * Three different truths hide behind "cannot see", and the user can act on
 * two of them. The model's image part is missing and the app knows where it
 * is: one click adds it, right here. The part is installed and the model was
 * loaded without it: say that, the model menu says why. Anything else is a
 * model without image input, and the sentence the composer wrote stands.
 */
function BlindModelNotice({ text }: { text: string }) {
  const model = useModelStore((s) => s.models.find((m) => m.name === s.activeModel))
  const part = useImagePartOffer(model)
  if (part.offer || part.downloading || part.error) {
    return (
      <>
        {IMAGE_INPUT_MISSING}
        <AddImageInput model={model} label={model ? `${displayModelName(model.name)} image input` : undefined} variant="inline" />
      </>
    )
  }
  if (part.loadedWithout) return <>{IMAGE_INPUT_LOADED_WITHOUT}</>
  return <>{text}</>
}
