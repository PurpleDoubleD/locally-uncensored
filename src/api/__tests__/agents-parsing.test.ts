import { describe, it, expect } from 'vitest'
import {
  AGENT_TOOLS,
  buildReActPrompt,
  buildJsonRetryPrompt,
  parseAgentResponse,
} from '../agents'
import type { AgentLogEntry } from '../../types/agents'

describe('agents — pure functions', () => {
  // ─── AGENT_TOOLS ───

  describe('AGENT_TOOLS', () => {
    it('has exactly 5 tools', () => {
      expect(AGENT_TOOLS).toHaveLength(5)
    })

    it('contains web_search, file_read, file_write, code_execute, image_generate', () => {
      const names = AGENT_TOOLS.map((t) => t.name)
      expect(names).toContain('web_search')
      expect(names).toContain('file_read')
      expect(names).toContain('file_write')
      expect(names).toContain('code_execute')
      expect(names).toContain('image_generate')
    })

    it('every tool has name, description, and parameters array', () => {
      for (const tool of AGENT_TOOLS) {
        expect(typeof tool.name).toBe('string')
        expect(tool.name.length).toBeGreaterThan(0)
        expect(typeof tool.description).toBe('string')
        expect(tool.description.length).toBeGreaterThan(0)
        expect(Array.isArray(tool.parameters)).toBe(true)
        expect(tool.parameters.length).toBeGreaterThan(0)
      }
    })

    it('every parameter has name, type, description, required', () => {
      for (const tool of AGENT_TOOLS) {
        for (const param of tool.parameters) {
          expect(typeof param.name).toBe('string')
          expect(typeof param.type).toBe('string')
          expect(typeof param.description).toBe('string')
          expect(typeof param.required).toBe('boolean')
        }
      }
    })

    it('file_write and code_execute require approval', () => {
      const fileWrite = AGENT_TOOLS.find((t) => t.name === 'file_write')
      const codeExec = AGENT_TOOLS.find((t) => t.name === 'code_execute')
      expect(fileWrite?.requiresApproval).toBe(true)
      expect(codeExec?.requiresApproval).toBe(true)
    })

    it('web_search, file_read, image_generate do not require approval', () => {
      const noApproval = ['web_search', 'file_read', 'image_generate']
      for (const name of noApproval) {
        const tool = AGENT_TOOLS.find((t) => t.name === name)
        expect(tool?.requiresApproval).toBe(false)
      }
    })
  })

  // ─── buildReActPrompt ───

  describe('buildReActPrompt', () => {
    it('output contains the goal text', () => {
      const prompt = buildReActPrompt('Find weather data', AGENT_TOOLS, [])
      expect(prompt).toContain('Find weather data')
    })

    it('output contains tool names and descriptions', () => {
      const prompt = buildReActPrompt('test', AGENT_TOOLS, [])
      expect(prompt).toContain('web_search')
      expect(prompt).toContain('file_read')
      expect(prompt).toContain('file_write')
      expect(prompt).toContain('code_execute')
      expect(prompt).toContain('image_generate')
    })

    it('output contains parameter details for tools', () => {
      const prompt = buildReActPrompt('test', AGENT_TOOLS, [])
      expect(prompt).toContain('query')
      expect(prompt).toContain('path')
      expect(prompt).toContain('content')
      expect(prompt).toContain('code')
      expect(prompt).toContain('prompt')
    })

    it('output contains JSON format instructions', () => {
      const prompt = buildReActPrompt('test', AGENT_TOOLS, [])
      expect(prompt).toContain('"thought"')
      expect(prompt).toContain('"action"')
      expect(prompt).toContain('"finish"')
    })

    it('includes history entries when present', () => {
      const history: AgentLogEntry[] = [
        { type: 'thought', content: 'I should search the web', timestamp: Date.now() },
        { type: 'action', content: 'web_search({"query":"test"})', timestamp: Date.now() },
        { type: 'observation', content: 'Found 3 results', timestamp: Date.now() },
      ]
      const prompt = buildReActPrompt('test', AGENT_TOOLS, history)
      expect(prompt).toContain('Thought: I should search the web')
      expect(prompt).toContain('Action: web_search')
      expect(prompt).toContain('Observation: Found 3 results')
      expect(prompt).toContain('Continue from where you left off')
    })

    it('says "Begin working" when history is empty', () => {
      const prompt = buildReActPrompt('test', AGENT_TOOLS, [])
      expect(prompt).toContain('Begin working on the goal now')
    })

    it('includes error entries from history', () => {
      const history: AgentLogEntry[] = [
        { type: 'error', content: 'Tool failed: network error', timestamp: Date.now() },
      ]
      const prompt = buildReActPrompt('test', AGENT_TOOLS, history)
      expect(prompt).toContain('Error: Tool failed: network error')
    })

    it('includes user_input entries from history', () => {
      const history: AgentLogEntry[] = [
        { type: 'user_input', content: 'Please try again', timestamp: Date.now() },
      ]
      const prompt = buildReActPrompt('test', AGENT_TOOLS, history)
      expect(prompt).toContain('User: Please try again')
    })
  })

  // ─── buildJsonRetryPrompt ───

  describe('buildJsonRetryPrompt', () => {
    it('mentions the original response was unparsable', () => {
      const prompt = buildJsonRetryPrompt('some garbage text')
      expect(prompt).toContain('could not be parsed as valid JSON')
    })

    it('includes the original response text', () => {
      const prompt = buildJsonRetryPrompt('I think we should search for cats')
      expect(prompt).toContain('I think we should search for cats')
    })

    it('truncates original response at 500 characters', () => {
      const longText = 'A'.repeat(1000)
      const prompt = buildJsonRetryPrompt(longText)
      // The original response is sliced to 500 chars
      const aCount = (prompt.match(/A/g) || []).length
      expect(aCount).toBe(500)
    })

    it('contains JSON format instructions', () => {
      const prompt = buildJsonRetryPrompt('oops')
      expect(prompt).toContain('"thought"')
      expect(prompt).toContain('"action"')
      expect(prompt).toContain('"finish"')
    })
  })

  // ─── parseAgentResponse ───

  describe('parseAgentResponse', () => {
    it('parses valid JSON response with action', () => {
      const json = JSON.stringify({
        thought: 'I need to search',
        action: 'web_search',
        args: { query: 'cats' },
      })
      const result = parseAgentResponse(json)
      expect(result.thought).toBe('I need to search')
      expect(result.action).toBe('web_search')
      expect(result.args).toEqual({ query: 'cats' })
    })

    it('parses JSON inside a code block', () => {
      const response = '```json\n{"thought": "testing", "action": "file_read", "args": {"path": "test.txt"}}\n```'
      const result = parseAgentResponse(response)
      expect(result.thought).toBe('testing')
      expect(result.action).toBe('file_read')
      expect(result.args).toEqual({ path: 'test.txt' })
    })

    it('parses JSON inside a bare code block (no json tag)', () => {
      const response = '```\n{"thought": "bare", "action": "finish", "answer": "done"}\n```'
      const result = parseAgentResponse(response)
      expect(result.thought).toBe('bare')
      expect(result.action).toBe('finish')
      expect(result.answer).toBe('done')
    })

    it('handles plain thought response (no JSON)', () => {
      const response = 'I am just thinking about the problem and have no action to take.'
      const result = parseAgentResponse(response)
      expect(result.thought).toBe(response)
      expect(result.action).toBe('continue')
      expect(result.args).toEqual({})
    })

    it('handles response with final answer', () => {
      const json = JSON.stringify({
        thought: 'Task complete',
        action: 'finish',
        answer: 'The weather is sunny',
      })
      const result = parseAgentResponse(json)
      expect(result.action).toBe('finish')
      expect(result.answer).toBe('The weather is sunny')
    })

    it('handles response with only thought (no action key)', () => {
      const json = JSON.stringify({ thought: 'Just thinking' })
      const result = parseAgentResponse(json)
      expect(result.thought).toBe('Just thinking')
      expect(result.action).toBe('continue')
    })

    it('handles empty response', () => {
      const result = parseAgentResponse('')
      expect(result.action).toBe('continue')
      expect(result.thought).toBe('')
    })

    it('normalizes action name to lowercase', () => {
      const json = JSON.stringify({
        thought: 'test',
        action: 'Web_Search',
        args: { query: 'test' },
      })
      const result = parseAgentResponse(json)
      expect(result.action).toBe('web_search')
    })

    it('handles alternative field names: thinking, tool, arguments', () => {
      const json = JSON.stringify({
        thinking: 'alternative thinking',
        tool: 'code_execute',
        arguments: { code: 'print(1)' },
      })
      const result = parseAgentResponse(json)
      expect(result.thought).toBe('alternative thinking')
      expect(result.action).toBe('code_execute')
      expect(result.args).toEqual({ code: 'print(1)' })
    })

    it('handles alternative field: reasoning', () => {
      const json = JSON.stringify({
        reasoning: 'my reasoning',
        action: 'finish',
        final_answer: 'all done',
      })
      const result = parseAgentResponse(json)
      expect(result.thought).toBe('my reasoning')
      expect(result.answer).toBe('all done')
    })

    it('handles alternative field: parameters (as args)', () => {
      const json = JSON.stringify({
        thought: 'test',
        action: 'file_write',
        parameters: { path: 'a.txt', content: 'hello' },
      })
      const result = parseAgentResponse(json)
      expect(result.args).toEqual({ path: 'a.txt', content: 'hello' })
    })

    it('handles alternative field: input (as args)', () => {
      const json = JSON.stringify({
        thought: 'test',
        action: 'web_search',
        input: { query: 'dogs' },
      })
      const result = parseAgentResponse(json)
      expect(result.args).toEqual({ query: 'dogs' })
    })

    it('recovers from malformed JSON with regex fallback', () => {
      const response = 'Here is my plan:\n"thought": "search for info"\n"action": "web_search"\n"answer": "found it"'
      const result = parseAgentResponse(response)
      expect(result.thought).toBe('search for info')
      expect(result.action).toBe('web_search')
      expect(result.answer).toBe('found it')
    })

    it('truncates long plain-text thought at 500 chars', () => {
      const longText = 'B'.repeat(1000)
      const result = parseAgentResponse(longText)
      expect(result.thought).toHaveLength(500)
      expect(result.action).toBe('continue')
    })

    it('handles JSON with extra text before and after', () => {
      const response = 'Sure, here is my response:\n{"thought": "mixed", "action": "finish", "answer": "ok"}\nThat was my answer.'
      const result = parseAgentResponse(response)
      expect(result.thought).toBe('mixed')
      expect(result.action).toBe('finish')
      expect(result.answer).toBe('ok')
    })
  })
})
