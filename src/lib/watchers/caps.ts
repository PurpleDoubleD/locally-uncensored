// Watchers: what a watcher may do, as the cap over its chat's permissions
// while it runs (lib/remote-turn-caps, the same slot a phone turn uses).
//
// A run has nobody in front of it. So the cap is both ways: what the user
// ticked when the watcher was made runs without a question (they answered it
// then), everything else is off. A question that still comes up (a per-tool
// "ask" the user set) is answered with no by the runner.
import type { PermissionMap, ToolCategory } from '../../api/mcp/types'
import type { WatcherRights } from './types'

export function watcherCaps(r: WatcherRights): PermissionMap {
  const on = (yes: boolean): 'auto' | 'blocked' => (yes ? 'auto' : 'blocked')
  const map: Record<ToolCategory, 'auto' | 'blocked'> = {
    web: on(r.web),
    filesystem: on(r.files),
    terminal: on(r.terminal),
    image: on(r.create),
    video: on(r.create),
    workflow: on(r.create),
    // Planning, the clock and the like. The self-control tools in it refuse a
    // watcher's run by themselves (lib/self-control-policy.ts).
    system: 'auto',
    // The screen and the tools of an external MCP server can do anything:
    // never without someone watching.
    desktop: 'blocked',
    mcp: 'blocked',
  }
  return map
}
