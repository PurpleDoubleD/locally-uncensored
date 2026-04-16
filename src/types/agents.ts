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
  | "code_execute"
  | "image_generate"
  | "get_current_time";

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
  args: Record<string, any>;
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
