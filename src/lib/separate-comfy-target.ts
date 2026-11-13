/**
 * C80 (3.1.0, GitHub #230): install a second, separate ComfyUI next to one LU
 * already found, for example to keep a hand-tuned install untouched.
 *
 * `install_comfyui` takes an install path, but the buttons only offered it
 * when no ComfyUI was found. The user picks a folder; this decides where the
 * new install goes, so the answer can be shown before anything is downloaded.
 *
 * - A folder whose name already says ComfyUI is taken as it is.
 * - Any other folder gets a `ComfyUI` subfolder, so picking `D:\AI` does not
 *   spill a git checkout into a folder full of other things.
 * - The folder LU already uses is refused: that would update it, not add one.
 */
export type SeparateComfyTarget = { ok: true; target: string } | { ok: false; reason: string }

function trimSeparators(path: string): string {
  let p = path.trim()
  // Keep a bare root ("/", "C:\") whole.
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return p
}

function sameFolder(a: string, b: string, onWindows: boolean): boolean {
  const norm = (s: string) => {
    const t = trimSeparators(s).replace(/\\/g, '/')
    return onWindows ? t.toLowerCase() : t
  }
  return norm(a) === norm(b)
}

export function separateComfyTarget(picked: string, currentPath: string | null | undefined, onWindows: boolean): SeparateComfyTarget {
  const folder = trimSeparators(picked)
  if (!folder) return { ok: false, reason: 'No folder was chosen.' }
  const sep = onWindows ? '\\' : '/'
  const base = folder.split(/[\\/]/).pop() ?? ''
  const target = /comfyui/i.test(base) ? folder : `${folder}${/[\\/]$/.test(folder) ? '' : sep}ComfyUI`
  if (currentPath && sameFolder(target, currentPath, onWindows)) {
    return {
      ok: false,
      reason: 'That is the ComfyUI LU already uses. Pick another folder for the separate install.',
    }
  }
  return { ok: true, target }
}
