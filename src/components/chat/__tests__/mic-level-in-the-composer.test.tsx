// @vitest-environment jsdom
/**
 * The composer shows the live microphone trace while a take runs, and only
 * then (David, 14.11.2026). One composer serves Chat, Agent and Code.
 *
 * Run: npx vitest run src/components/chat/__tests__/mic-level-in-the-composer.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../VoiceButton', () => ({
  VoiceButton: ({ onRecordingChange }: { onRecordingChange?: (r: boolean) => void }) => (
    <>
      <button type="button" onClick={() => onRecordingChange?.(true)}>fake start</button>
      <button type="button" onClick={() => onRecordingChange?.(false)}>fake stop</button>
    </>
  ),
}))

import { ChatInput } from '../ChatInput'

afterEach(() => cleanup())

describe('the composer and the microphone', () => {
  it('shows the trace while recording and takes it away after', () => {
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} modelReady={() => true} />)
    expect(screen.queryByTestId('mic-level-trace')).toBeNull()
    act(() => { fireEvent.click(screen.getByText('fake start')) })
    expect(screen.getByTestId('mic-level-trace')).toBeTruthy()
    expect(screen.getByTestId('mic-level-clock').textContent).toBe('0:00')
    act(() => { fireEvent.click(screen.getByText('fake stop')) })
    expect(screen.queryByTestId('mic-level-trace')).toBeNull()
  })
})
