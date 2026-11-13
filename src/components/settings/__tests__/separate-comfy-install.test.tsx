/**
 * @vitest-environment jsdom
 *
 * C80 (3.1.0, GitHub #230): "Install a separate ComfyUI…" picks a folder,
 * shows where the new install goes and only then starts it.
 *
 * Negative control: call onInstall straight from the picker and the
 * "nothing starts before the confirm" case turns red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

let picked: string | null = 'D:\\AI'
vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  isWindows: () => true,
  backendCall: vi.fn(async (cmd: string) => (cmd === 'pick_folder' ? picked : null)),
}))

const { SeparateComfyInstall } = await import('../SeparateComfyInstall')

beforeEach(() => { picked = 'D:\\AI' })
afterEach(cleanup)

describe('C80: a separate ComfyUI next to the found one', () => {
  it('shows the target and starts nothing before the confirm', async () => {
    const onInstall = vi.fn()
    render(<SeparateComfyInstall currentPath={'C:\\Users\\a\\ComfyUI'} onInstall={onInstall} />)
    fireEvent.click(screen.getByText(/Install a separate ComfyUI/))
    const line = await screen.findByTestId('separate-comfy-target')
    expect(line.textContent).toContain('D:\\AI\\ComfyUI')
    expect(line.textContent).toContain('C:\\Users\\a\\ComfyUI')
    expect(onInstall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('separate-comfy-confirm'))
    expect(onInstall).toHaveBeenCalledWith('D:\\AI\\ComfyUI')
  })

  it('a cancelled picker changes nothing', async () => {
    picked = null
    const onInstall = vi.fn()
    render(<SeparateComfyInstall currentPath={'C:\\ComfyUI'} onInstall={onInstall} />)
    fireEvent.click(screen.getByText(/Install a separate ComfyUI/))
    await waitFor(() => expect(screen.getByTestId('separate-comfy-open')).toBeTruthy())
    expect(screen.queryByTestId('separate-comfy-target')).toBeNull()
    expect(onInstall).not.toHaveBeenCalled()
  })

  it('refuses the folder LU already uses', async () => {
    picked = 'C:\\Users\\a'
    const onInstall = vi.fn()
    render(<SeparateComfyInstall currentPath={'C:\\Users\\a\\ComfyUI'} onInstall={onInstall} />)
    fireEvent.click(screen.getByText(/Install a separate ComfyUI/))
    expect((await screen.findByRole('alert')).textContent).toMatch(/already uses/)
    expect(screen.queryByTestId('separate-comfy-confirm')).toBeNull()
  })
})
