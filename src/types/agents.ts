import type { ToolArgs } from '../api/mcp/types';

export type AgentStatus =
  | "idle"
  | "planning"
  | "executing"
  | "paused"
  | "completed"
  | "failed";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type ToolName =
  | "web_search"
  | "web_fetch"
  | "file_read"
  | "file_write"
  | "image_generate";

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface Tool {
  name: ToolName;
  description: string;
  parameters: ToolParameter[];
  requiresApproval: boolean;
}

export interface ToolCall {
  id: string;
  tool: ToolName;
  /* Was `Record<string, any>` — same story as agent-mode.ts: this is ToolArgs,
     and the guards were already doing the narrowing the `any` pretended to
     make unnecessary. */
  args: ToolArgs;
  result?: string;
  error?: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "approved"
    | "rejected"
    | "cached";
  timestamp: number;
  duration?: number;
  // v2.4 observability — all optional, additive.
  startedAt?: number;
  completedAt?: number;
  cacheHit?: boolean;
  parentToolCallId?: string;
  schemaValidated?: boolean;
  errorHint?: string;
  sideEffectKey?: string;
}

export interface AgentTask {
  id: string;
  description: string;
  status: TaskStatus;
  toolCalls: ToolCall[];
  reasoning?: string;
  order: number;
}

export interface AgentLogEntry {
  id: string;
  type: "thought" | "action" | "observation" | "error" | "user_input";
  content: string;
  timestamp: number;
  toolCall?: ToolCall;
}

export interface AgentRun {
  id: string;
  goal: string;
  model: string;
  status: AgentStatus;
  tasks: AgentTask[];
  log: AgentLogEntry[];
  createdAt: number;
  updatedAt: number;
  maxIterations: number;
  currentIteration: number;
}
