// @vitest-environment jsdom
/**
 * Ein gemerkter Ordner wird gefragt, bevor er gesetzt wird.
 *
 * Fehler D hat den DIALOG ehrlich gemacht: `pick_folder` meldet seit dem
 * 11.09.2026 mit `asWorkspace`, wenn die Rust-Seite einen Ordner nicht als
 * Arbeitsordner annimmt, und ein abgelehnter Ordner wird gar nicht erst
 * gesetzt. Zwei Wege kamen ohne Dialog aus und blieben deshalb stehen:
 *
 *   1. "Use last folder" nahm den zuletzt gewaehlten Pfad ungeprueft.
 *   2. Der gemerkte Vorgabeordner uebersprang die Frage in JEDEM neuen
 *      Agentenchat, ohne dass irgendjemand ihn noch einmal angesehen haette.
 *
 * Beide Pfade leben im Speicher des Browsers, die Erlaubnisliste der
 * Rust-Seite liegt daneben in einer Datei, und die zwei laufen auseinander:
 * frische Installation, geleerte Daten, oder ein Ordner direkt unter `$HOME`,
 * den eine aeltere Fassung noch gesetzt hat. Danach steht der Ordner in der
 * Kopfzeile und jede Dateioperation antwortet mit "pick it again to allow it",
 * und es geht kein Dialog auf, in dem man genau das tun koennte.
 *
 * Der neue Befehl `validate_workspace_folder` faellt dasselbe Urteil wie der
 * Dialogweg und merkt sich NICHTS dabei. Ein alter Pfad wird also nicht still
 * in die Erlaubnisliste nachgezogen; das haelt auf der Rust-Seite
 * `home_and_a_never_picked_folder_do_not_validate` fest.
 *
 * Lauf: npx vitest run src/components/chat/__tests__/der-gemerkte-ordner-wird-gefragt.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

vi.mock('../../../api/backend', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  backendCall: vi.fn(),
  isTauri: () => true,
}))

import { AgentWorkspaceDialog } from '../AgentWorkspaceDialog'
import { backendCall } from '../../../api/backend'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { rememberedWorkspaceRefusedMessage } from '../../../lib/workspace-rejected'

const CONV = 'conv-remembered'
const LAST = '/Users/x/old-project'
/** Wortgleich der Satz, den `check_workspace_root` fuer eine fremde Wurzel schickt. */
const REFUSAL =
  "Not an allowed workspace folder (only a folder you chose in LU's folder picker " +
  `can be a workspace, pick it again to allow it): ${LAST}`

const call = vi.mocked(backendCall)

beforeEach(() => {
  cleanup()
  call.mockReset()
  useAgentModeStore.setState({ lastFolder: LAST, workspaces: {} })
})

function openDialog(onChoose = vi.fn()) {
  render(
    <AgentWorkspaceDialog
      open
      conversationId={CONV}
      onChoose={onChoose}
      onClose={vi.fn()}
    />,
  )
  return onChoose
}

describe('der Knopf "Use last folder"', () => {
  it('setzt einen Ordner nicht, den die Erlaubnisliste ablehnt', async () => {
    call.mockRejectedValue(new Error(REFUSAL))
    const onChoose = openDialog()

    fireEvent.click(screen.getByText('Use last folder'))

    await waitFor(() => expect(screen.getByText(/Cannot use/)).toBeTruthy())
    expect(onChoose, 'der abgelehnte Ordner wurde trotzdem gesetzt').not.toHaveBeenCalled()
    // Gefragt wurde der Befehl, der nichts merkt.
    expect(call.mock.calls[0][0]).toBe('validate_workspace_folder')
    expect(call.mock.calls[0][1]).toEqual({ path: LAST })
  })

  it('und der Nutzer liest den Grund samt Ordner, nicht nur ein totes Nichts', async () => {
    call.mockRejectedValue(new Error(REFUSAL))
    openDialog()

    fireEvent.click(screen.getByText('Use last folder'))

    const shown = await screen.findByText(/Cannot use/)
    expect(shown.textContent).toContain(LAST)
    expect(shown.textContent).toContain('pick it again to allow it')
    // Der Weg heraus steht daneben, und es ist der native Dialog.
    expect(shown.textContent).toContain('Pick a folder')
    expect(screen.getByText('Pick a folder…')).toBeTruthy()
  })

  it('nimmt einen Ordner, den die Erlaubnisliste kennt, weiterhin sofort', async () => {
    call.mockResolvedValue(undefined)
    const onChoose = openDialog()

    fireEvent.click(screen.getByText('Use last folder'))

    await waitFor(() =>
      expect(onChoose).toHaveBeenCalledWith({ kind: 'folder', path: LAST, extraPaths: [] }),
    )
  })
})

describe('der gemerkte Vorgabeordner', () => {
  it('bringt seinen Grund mit, wenn der Dialog seinetwegen aufgeht', () => {
    const why = rememberedWorkspaceRefusedMessage(LAST, new Error(REFUSAL))
    render(
      <AgentWorkspaceDialog
        open
        conversationId={CONV}
        onChoose={vi.fn()}
        onClose={vi.fn()}
        initialError={why}
      />,
    )
    expect(screen.getByText(/Cannot use/).textContent).toBe(why)
  })

  it('wird geprueft, bevor die Frage uebersprungen wird', async () => {
    // Seit 3.1.2 faellt die Weiche bei der ersten Nachricht im Chat
    // (lib/agent-workspace-ask.ts), nicht mehr beim Einschalten. Die Regel
    // ist dieselbe: ein abgelehnter Vorgabeordner fuehrt zur Frage MIT Grund.
    const { workspaceAskNeeded } = await import('../../../lib/agent-workspace-ask')
    const { useSettingsStore } = await import('../../../stores/settingsStore')
    useSettingsStore.getState().updateSettings({ defaultWorkspace: { kind: 'folder', path: LAST } })
    call.mockRejectedValueOnce(new Error(REFUSAL))
    const grund = await workspaceAskNeeded(CONV)
    expect(call).toHaveBeenCalledWith('validate_workspace_folder', { path: LAST })
    expect(grund, 'der gemerkte Vorgabeordner wird wieder ungeprueft genommen').toMatch(/Cannot use/)
    // Ein Ordner, den die Erlaubnisliste kennt, ersetzt die Frage weiterhin.
    call.mockResolvedValueOnce(undefined)
    expect(await workspaceAskNeeded(CONV)).toBeNull()
    useSettingsStore.getState().updateSettings({ defaultWorkspace: null })
    // Und nichts wird dabei nachgezogen: merken kann nur der native Dialog.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../lib/agent-workspace-ask.ts'),
      'utf8',
    )
    expect(src).not.toContain('remember_picked_root')
  })
})

describe('der Satz fuer einen gemerkten Ordner', () => {
  it('nennt den Ordner, den Grund und den Weg heraus', () => {
    const satz = rememberedWorkspaceRefusedMessage('D:\\code', 'a home or mount container is not a workspace')
    expect(satz).toContain('D:\\code')
    expect(satz).toContain('a home or mount container is not a workspace')
    expect(satz).toContain('The folder was not taken.')
  })

  it('vertraegt einen rohen String genauso wie ein Error', () => {
    expect(rememberedWorkspaceRefusedMessage('/x', new Error('boom'))).toContain('boom')
    expect(rememberedWorkspaceRefusedMessage('/x', 'boom')).toContain('boom')
  })
})
