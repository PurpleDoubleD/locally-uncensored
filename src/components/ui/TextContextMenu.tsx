// W33: the right click of the whole window (see lib/text-context-menu.ts).
// Mounted once in App. Listens on the document after React's own handlers,
// so a menu of LU's own (chat message, model, gallery tile) that already
// called preventDefault is left alone.
import { useEffect, useState } from 'react'
import { ContextMenu } from './ContextMenu'
import type { MenuAction } from './menu-actions'
import { log } from '../../lib/logger'
import { isTauri } from '../../api/backend'
import {
  TEXT_ACTION_LABEL, editableOf, keepsNativeMenu, readTarget, textMenuActions, type TextAction,
} from '../../lib/text-context-menu'

interface Open {
  x: number
  y: number
  actions: TextAction[]
  field: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
  range: [number, number] | null
  selected: string
}

/** Put the field back as it was at the right click: focus and selection. */
function restore(o: Open) {
  const f = o.field
  if (!f) return
  f.focus()
  if (o.range && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) f.setSelectionRange(o.range[0], o.range[1])
}

async function run(o: Open, action: TextAction) {
  try {
    if (action === 'copy') {
      await navigator.clipboard.writeText(o.selected)
      restore(o)
      return
    }
    if (action === 'cut') {
      await navigator.clipboard.writeText(o.selected)
      restore(o)
      // Through the editing command, so the field's undo and React's
      // onChange see it like typing.
      document.execCommand('insertText', false, '')
      return
    }
    if (action === 'paste') {
      const text = await navigator.clipboard.readText()
      restore(o)
      document.execCommand('insertText', false, text)
      return
    }
    restore(o)
    const f = o.field
    if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) f.select()
    else document.execCommand('selectAll')
  } catch (err) {
    log.warn('text_menu.action_failed', { action, err: String(err) })
  }
}

export function TextContextMenu() {
  const [open, setOpen] = useState<Open | null>(null)

  useEffect(() => {
    // The app only: in a browser the browser's own menu belongs to the user.
    if (keepsNativeMenu(import.meta.env.DEV) || !isTauri()) return
    const onMenu = (e: MouseEvent) => {
      // A menu of LU's own took this click.
      if (e.defaultPrevented) return
      e.preventDefault()
      const el = e.target instanceof Element ? e.target : null
      const selected = window.getSelection()?.toString() ?? ''
      const field = editableOf(el)
      let range: [number, number] | null = null
      let fieldSelected = selected
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        range = [field.selectionStart ?? 0, field.selectionEnd ?? 0]
        fieldSelected = field.value.slice(range[0], range[1])
      }
      const actions = textMenuActions(readTarget(el, fieldSelected))
      setOpen(actions.length > 0 ? { x: e.clientX, y: e.clientY, actions, field, range, selected: fieldSelected } : null)
    }
    document.addEventListener('contextmenu', onMenu)
    return () => document.removeEventListener('contextmenu', onMenu)
  }, [])

  if (!open) return null
  const items: MenuAction[] = open.actions.map((a) => ({ id: a, label: TEXT_ACTION_LABEL[a], run: () => { void run(open, a) } }))
  return <ContextMenu items={items} x={open.x} y={open.y} label="Text" onClose={() => setOpen(null)} />
}
