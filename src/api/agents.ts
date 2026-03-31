import type { Tool, ToolName, ToolCall, AgentLogEntry } from "../types/agents";

export const AGENT_TOOLS: Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for information using a multi-tier approach. SearXNG (if installed locally) gives the best results with full search capabilities. Falls back to DuckDuckGo Instant Answers and Wikipedia. Returns results with titles, snippets, and URLs.",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "The search query string",
        required: true,
      },
      {
        name: "maxResults",
        type: "number",
        description: "Maximum number of results to return (default: 5)",
        required: false,
      },
    ],
    requiresApproval: false,
  },
  {
    name: "file_read",
    description:
      "Read the contents of a file from the local filesystem within the agent workspace.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file within the workspace",
        required: true,
      },
    ],
    requiresApproval: false,
  },
  {
    name: "file_write",
    description:
      "Write content to a file in the agent workspace. Creates the file if it does not exist, overwrites if it does.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file within the workspace",
        required: true,
      },
      {
        name: "content",
        type: "string",
        description: "The content to write to the file",
        required: true,
      },
    ],
    requiresApproval: true,
  },
  {
    name: "code_execute",
    description:
      "Execute code in a sandboxed environment. Supports Python and shell commands. Returns stdout, stderr, and exit code.",
    parameters: [
      {
        name: "code",
        type: "string",
        description: "The code to execute",
        required: true,
      },
      {
        name: "language",
        type: "string",
        description: 'Programming language: "python" or "shell" (default: "python")',
        required: false,
      },
    ],
    requiresApproval: true,
  },
  {
    name: "image_generate",
    description:
      "Generate an image from a text description. Delegates to the Create tab for image generation.",
    parameters: [
      {
        name: "prompt",
        type: "string",
        description: "Text description of the image to generate",
        required: true,
      },
      {
        name: "negativePrompt",
        type: "string",
        description: "Things to avoid in the generated image",
        required: false,
      },
    ],
    requiresApproval: false,
  },
];

export function buildReActPrompt(
  goal: string,
  tools: Tool[],
  history: AgentLogEntry[]
): string {
  const toolDescriptions = tools
    .map((t) => {
      const params = t.parameters
        .map(
          (p) =>
            `    - ${p.name} (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`
        )
        .join("\n");
      return `  ${t.name}: ${t.description}\n  Parameters:\n${params}`;
    })
    .join("\n\n");

  const historyText = history
    .map((entry) => {
      switch (entry.type) {
        case "thought":
          return `Thought: ${entry.content}`;
        case "action":
          return `Action: ${entry.content}`;
        case "observation":
          return `Observation: ${entry.content}`;
        case "error":
          return `Error: ${entry.content}`;
        case "user_input":
          return `User: ${entry.content}`;
        default:
          return entry.content;
      }
    })
    .join("\n");

  const codeBlockOpen = "``" + "`json";
  const codeBlockClose = "``" + "`";

  return `You are an autonomous AI agent. Your goal is: ${goal}

You have access to the following tools:

${toolDescriptions}

You must respond with a JSON object in one of these two formats:

To use a tool:
${codeBlockOpen}
{"thought": "your reasoning about what to do next", "action": "tool_name", "args": {"param1": "value1"}}
${codeBlockClose}

To finish the task:
${codeBlockOpen}
{"thought": "your final reasoning", "action": "finish", "answer": "your final answer or summary of what was accomplished"}
${codeBlockClose}

Rules:
- Always include a "thought" explaining your reasoning
- Use exactly one action per response
- Only use tools from the list above
- If a tool returns an error, try a different approach
- When the goal is accomplished, use the "finish" action
- Be concise and efficient

${historyText ? `\nPrevious steps:\n${historyText}\n\nContinue from where you left off.` : "Begin working on the goal now."}`;
}

/**
 * Build a simplified retry prompt when the LLM failed to produce valid JSON.
 */
export function buildJsonRetryPrompt(originalResponse: string): string {
  return `Your previous response could not be parsed as valid JSON. Please respond with ONLY a valid JSON object, no other text.

Your previous (unparsable) response was:
${originalResponse.slice(0, 500)}

Respond with ONLY a JSON object in this exact format:
{"thought": "your reasoning", "action": "tool_name", "args": {"param": "value"}}

Or to finish:
{"thought": "your reasoning", "action": "finish", "answer": "your answer"}`;
}

/**
 * Robustly parse an LLM agent response into structured thought/action/args.
 *
 * Handles:
 * 1. JSON in code blocks
 * 2. Multiple JSON objects (takes the first)
 * 3. Partial/broken JSON via regex fallback
 * 4. No JSON at all (treats as thought with action "continue")
 * 5. Action name casing normalization
 * 6. Alternative field names (thinking, reasoning, tool, arguments, parameters, etc.)
 */
export function parseAgentResponse(response: string): {
  thought: string;
  action: string;
  args?: Record<string, any>;
  answer?: string;
} {
  // 1. Try to find JSON in code blocks first
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonCandidate = codeBlockMatch ? codeBlockMatch[1] : response;

  // 2. Try to find a JSON object
  const jsonMatch = jsonCandidate.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        thought: parsed.thought || parsed.thinking || parsed.reasoning || "",
        action: (parsed.action || parsed.tool || "continue").toLowerCase().trim(),
        args: parsed.args || parsed.arguments || parsed.parameters || parsed.input || {},
        answer: parsed.answer || parsed.final_answer || parsed.response || undefined,
      };
    } catch {
      // JSON parse failed - if there is a nested object, try the first one
      const firstObjMatch = jsonCandidate.match(/\{[^{}]*\}/);
      if (firstObjMatch && firstObjMatch[0] !== jsonMatch[0]) {
        try {
          const parsed = JSON.parse(firstObjMatch[0]);
          return {
            thought: parsed.thought || parsed.thinking || parsed.reasoning || "",
            action: (parsed.action || parsed.tool || "continue").toLowerCase().trim(),
            args: parsed.args || parsed.arguments || parsed.parameters || parsed.input || {},
            answer: parsed.answer || parsed.final_answer || parsed.response || undefined,
          };
        } catch {
          // Fall through to regex
        }
      }
    }
  }

  // 3. Regex fallback for individual fields
  const thoughtMatch = response.match(/["']?(?:thought|thinking|reasoning)["']?\s*[:=]\s*["']([^"']+)["']/i);
  const actionMatch = response.match(/["']?(?:action|tool)["']?\s*[:=]\s*["']([^"']+)["']/i);
  const answerMatch = response.match(/["']?(?:answer|final_answer|response)["']?\s*[:=]\s*["']([^"']+)["']/i);

  if (actionMatch) {
    return {
      thought: thoughtMatch?.[1] || "",
      action: actionMatch[1].toLowerCase().trim(),
      args: {},
      answer: answerMatch?.[1],
    };
  }

  // 4. Total fallback: treat entire response as a thought
  return {
    thought: response.slice(0, 500),
    action: "continue",
    args: {},
  };
}

export async function executeTool(
  tool: ToolName,
  args: Record<string, any>
): Promise<string> {
  switch (tool) {
    case "code_execute": {
      const res = await fetch("/local-api/execute-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: args.code,
          language: args.language || "python",
        }),
      });
      if (!res.ok) throw new Error(`code_execute failed: ${res.statusText}`);
      const data = await res.json();
      return `Exit code: ${data.exitCode ?? 0}\nStdout:\n${data.stdout || ""}\nStderr:\n${data.stderr || ""}`;
    }

    case "file_read": {
      const res = await fetch("/local-api/file-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: args.path }),
      });
      if (!res.ok) throw new Error(`file_read failed: ${res.statusText}`);
      const data = await res.json();
      return data.content || "";
    }

    case "file_write": {
      const res = await fetch("/local-api/file-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: args.path, content: args.content }),
      });
      if (!res.ok) throw new Error(`file_write failed: ${res.statusText}`);
      const data = await res.json();
      return data.message || "File written successfully";
    }

    case "web_search": {
      const res = await fetch("/local-api/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: args.query,
          maxResults: args.maxResults || 5,
        }),
      });
      if (!res.ok) throw new Error(`web_search failed: ${res.statusText}`);
      const data = await res.json();
      if (Array.isArray(data.results)) {
        return data.results
          .map(
            (r: any, i: number) =>
              `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
          )
          .join("\n\n");
      }
      return JSON.stringify(data);
    }

    case "image_generate": {
      return "Image generation delegated to Create tab";
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

export async function chatNonStreaming(
  model: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Chat API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.message?.content || data.response || "";
}
