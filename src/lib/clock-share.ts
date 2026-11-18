// 3.1.2 (A39, GitHub #257): the clock line of agent runs, behind the switch
// "Share date and time with the model" (Settings → Agent → Agent Permissions).
//
// A user writing a story with the agent on saw the model read the run's date,
// time and timezone as facts of the story, and quote them. The line stays on
// by default, because an agent searching the web or naming files needs to know
// what day it is; switched off, no date or time goes to the model on any path:
// the agent chat, Codex, the sub-agent and the phone's remote agent (which
// learns the desktop's choice from the /config of the remote server).
import { useSettingsStore } from '../stores/settingsStore'
import { hostClockLine } from './host-platform'

/** Whether the agent may be told the date and time. On unless switched off. */
export function clockShared(): boolean {
  try {
    return useSettingsStore.getState().settings.shareClockWithModel !== false
  } catch {
    return true
  }
}

/** The clock line, or '' when the user switched it off. */
export function agentClockLine(now: Date = new Date(), share: boolean = clockShared()): string {
  return share ? hostClockLine(now) : ''
}
