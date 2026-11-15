/**
 * @vitest-environment jsdom
 *
 * M1: the approval strip for a tool of an external MCP server says whose
 * tool it is ("Approve use Files: run") instead of the generic "use a tool".
 *
 * Run: npx vitest run src/components/chat/__tests__/approval-names-the-mcp-server.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { ApprovalDialog } from '../ApprovalDialog'
import { toolRegistry } from '../../../api/mcp/tool-registry'

afterEach(() => {
  cleanup()
  toolRegistry.unregisterServer('m1-srv')
})

describe('the approval strip for an MCP tool', () => {
  it('names the server and the tool', () => {
    toolRegistry.registerExternal('m1-srv', [{
      name: 'm1_run', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, category: 'mcp', source: 'external',
    }], async () => '', 'Files')
    const view = render(createElement(ApprovalDialog, {
      toolCall: { id: 'c', toolName: 'm1_run', args: {}, status: 'pending_approval', timestamp: 0 },
      onApprove: vi.fn(), onReject: vi.fn(),
    }))
    const what = view.getByTestId('approval-what')
    expect(what.textContent).toBe('use Files: m1_run')
    expect(what.getAttribute('title')).toBe('Files: m1_run')
  })
})
