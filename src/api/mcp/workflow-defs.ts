// The workflow tools as the registry sees them (C60-S5): schemas and the
// registration. Nothing heavy is imported here: the registry loads this with
// the app, and the stores, ComfyUI and download code behind the tools would
// run their import-time code in every module that only registers tools (the
// same split as self-control-defs.ts). The executors load on the first call.

import type { MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { WORKFLOW_ASSIGN, WORKFLOW_FIND, WORKFLOW_INSPECT, WORKFLOW_INSTALL } from '../../lib/workflow-tool-names'

export const WORKFLOW_TOOLS: MCPToolDefinition[] = [
  {
    name: WORKFLOW_FIND,
    brief: 'Find ComfyUI workflows (local, CivitAI, GitHub).',
    description: 'Find ComfyUI workflows: LU\'s own, ComfyUI templates, CivitAI and GitHub repos of the Comfy Registry. '
      + 'Read only. Returns ids for workflow_inspect. Pass url only when the user sent a link.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the workflow does, e.g. "flux upscale" or "wan 2.2 image to video".' },
        source: { type: 'string', enum: ['all', 'local', 'civitai', 'github'], description: 'Default all.' },
        url: { type: 'string', description: 'A workflow link the user wrote in their message (e.g. OpenArt, GitHub).' },
      },
      required: [],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: WORKFLOW_INSPECT,
    brief: 'Traffic light check of a found workflow.',
    description: 'Check one found workflow: nodes, models, size, license, risks, traffic light green/yellow/red. Read only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id from workflow_find.' } },
      required: ['id'],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: WORKFLOW_INSTALL,
    brief: "Install a checked workflow after the user's card.",
    description: 'Install a checked green or yellow workflow into LU (Create). The user confirms on a card. '
      + 'Optionally assign it to a model. Red is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id from workflow_find, checked with workflow_inspect.' },
        model: { type: 'string', description: 'Optional: image or video model file the workflow should be used for.' },
      },
      required: ['id'],
    },
    category: 'system',
    source: 'builtin',
  },
  {
    name: WORKFLOW_ASSIGN,
    brief: 'Use an installed workflow for a model.',
    description: 'Make an installed workflow the one a model generates with. The user confirms on a card.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Name or id of an installed workflow.' },
        model: { type: 'string', description: 'Model file name as ComfyUI lists it.' },
      },
      required: ['workflow', 'model'],
    },
    category: 'system',
    source: 'builtin',
  },
]


const load = () => import('./workflow-tools')

export function registerWorkflowTools(registry: ToolRegistry): void {
  registry.registerBuiltin(WORKFLOW_TOOLS[0], async (a, run) => (await load()).executeWorkflowFind(a, run))
  registry.registerBuiltin(WORKFLOW_TOOLS[1], async (a) => (await load()).executeWorkflowInspect(a))
  registry.registerBuiltin(WORKFLOW_TOOLS[2], async (a, run, signal) => (await load()).executeWorkflowInstall(a, run, signal))
  registry.registerBuiltin(WORKFLOW_TOOLS[3], async (a, run, signal) => (await load()).executeWorkflowAssign(a, run, signal))
}
