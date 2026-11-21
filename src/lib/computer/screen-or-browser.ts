/**
 * With Computer Control on, a request for the PC or "the browser" belongs on
 * the user's own screen.
 *
 * The keyword router knew no word for the screen tools, so they were dropped
 * from nearly every turn while the word "browser" brought browser_open. The
 * model then opened LU's own browser window instead of controlling the PC
 * (Discord report, 21.11.2026). The switch is the user's signal: the screen
 * tools ride along, and LU's browser stays out unless the user names it.
 */
import type { PermissionMap } from '../../api/mcp/types'
import { BROWSER_TOOL_NAMES } from '../browser-tools'
import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from './prompt'

const BROWSER_TOOLS: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES)

export const isScreenControlTool = (name: string): boolean =>
  name === COMPUTER_TASK_TOOL_NAME || name === COMPUTER_USE_TOOL_NAME

export const isLuBrowserTool = (name: string): boolean => BROWSER_TOOLS.has(name)

/** "LU browser", "lu-browser", "LU-Browser" or a browser tool by its name. */
export function namesTheLuBrowser(userText: string): boolean {
  return /\blu[\s-]?browser\b/i.test(userText) || BROWSER_TOOL_NAMES.some((name) => userText.toLowerCase().includes(name))
}

/** True when this turn keeps LU's browser window out of the model's reach. */
export function browserStepsAside(userText: string, screenToolAvailable: boolean): boolean {
  return screenToolAvailable && !namesTheLuBrowser(userText)
}

/** The router's choice plus the screen tools this run may use. */
export function withScreenTools<T extends { name: string; category?: string }>(
  chosen: T[],
  allowed: readonly T[],
  permissions: PermissionMap,
): T[] {
  const missing = allowed.filter((tool) =>
    isScreenControlTool(tool.name)
    && !(tool.category && permissions[tool.category as keyof PermissionMap] === 'blocked')
    && !chosen.some((c) => c.name === tool.name))
  return missing.length ? [...chosen, ...missing] : chosen
}
