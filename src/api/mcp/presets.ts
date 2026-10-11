import type { MCPServerConfig } from './types'

/** Opt-in stdio bridge for LU's existing external MCP client. */
export function parallelSearchConfig(id: string): MCPServerConfig {
  return {
    id,
    name: 'Parallel Search',
    command: 'npx',
    args: [
      '-y', 'mcp-remote@0.14.3', 'https://search.parallel.ai/mcp',
      '--transport', 'http-only',
      '--header', 'User-Agent:locally-uncensored',
    ],
    toolPrefix: 'parallel_',
    enabled: true,
  }
}
