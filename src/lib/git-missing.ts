/**
 * "Install Git" (3.1.3, Davids Wunsch 21.11.): where LU says that git is
 * missing, it offers a button instead of a web page.
 *
 * Every sentence the backend writes for a missing git starts with the same
 * head (`src-tauri/src/commands/install/git.rs`, test
 * `every_git_missing_sentence_starts_the_same_so_the_button_shows`), so one
 * check finds it in an install error or in the installer's last log line.
 */

export const GIT_MISSING_HEAD = 'Git is not installed'

/** Whether a text from an installer says that git is missing. */
export function isGitMissing(text: string | null | undefined): boolean {
  return !!text && text.includes(GIT_MISSING_HEAD)
}

/** What `install_git_status` answers (an `InstallState` plus `installed`). */
export interface GitInstallStatus {
  status?: string
  phase?: string
  logs?: string[]
  download_progress?: number
  download_total?: number
  installed?: boolean
  /** Linux: the package command to copy, when the distro is known. */
  command?: string | null
}

const MB = 1_000_000

/** The one status line next to the button. */
export function gitInstallLine(s: GitInstallStatus): string {
  const last = s.logs?.[s.logs.length - 1] ?? ''
  switch (s.status) {
    case 'downloading': {
      const total = s.download_total ?? 0
      if (total > 0) {
        const got = Math.min(s.download_progress ?? 0, total)
        return `Downloading Git... ${Math.round(got / MB)} of ${Math.round(total / MB)} MB`
      }
      return 'Downloading Git...'
    }
    case 'installing':
      return s.phase || last || 'Setting up Git...'
    case 'complete':
      return 'Git is ready.'
    case 'error':
      return last || 'Installing Git did not work.'
    case 'manual':
      return s.command ? 'Run this in a terminal, then press Check again:' : last
    default:
      return ''
  }
}
