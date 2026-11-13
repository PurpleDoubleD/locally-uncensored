/** Types for the plain-node module. It runs in CI without a build step, so the
 *  implementation stays .mjs and the types live here. */

export interface EnginePins {
  id: 'image' | 'mflux' | 'mlx-video' | 'ltx-2-mlx' | 'mesh3d'
  label: string
  source: string
  specs: string[]
}

export type ReadFile = (relativePath: string) => string

export declare const REPO_ROOT: string
export declare const SOURCES: Record<EnginePins['id'], string>
export declare const PYTHON_PIN_FILE: string
export declare const LTX_SPEC_TEMPLATE: string

export declare function isPinned(spec: string): boolean
export declare function rustStrArray(source: string, name: string): string[]
export declare function rustStrConst(source: string, name: string): string
export declare function requirementLines(text: string): string[]
export declare function readEnginePins(read?: ReadFile): EnginePins[]
export declare function pythonLine(read?: ReadFile): string
