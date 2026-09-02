import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import { isVideoModelType, type ModelType, } from '../api/comfyui'
import type { WorkflowTag, WorkflowTemplate } from '../types/workflows'
import { secretGet, secretSet, secretDelete } from '../api/backend'

// ── The CivitAI API key lives in the OS vault ──────────────────────────────
//
// Every other secret in the app already does (providerStore, the HuggingFace
// token in MlxMediaSettings). This one sat in localStorage in plain text,
// which is the same mistake providerStore's H5 fix was written for. Same
// shape, same limits: Windows Credential Manager and the macOS Keychain hold
// it, Linux desktop and the web build have no uniform vault and keep the
// localStorage path unchanged.

/** Keychain account for the CivitAI key. Keep it stable, changing it would
 *  orphan the stored key. */
export const CIVITAI_KEY_ACCOUNT = 'civitai-api-key'

// True once a secret_get has RESOLVED here, which is what proves the vault
// works. Module level so the static `partialize` below can read it.
let civitaiVaultReady = false
// True when a vault WRITE failed this session. partialize then KEEPS the key
// in localStorage, because a locked or full credential store must not make the
// key vanish on the next restart with no trace.
let civitaiVaultFailed = false

/** Test seam: the flags are module state, so a test needs a way back. */
export function __resetCivitaiVaultForTests(): void {
  civitaiVaultReady = false
  civitaiVaultFailed = false
}

/**
 * Load the key from the OS vault, and move an existing localStorage key into it
 * once. Called at boot.
 *
 * A reject on the very first probe means there is no vault here (web build, or
 * Linux "unsupported"), and everything stays exactly as it was.
 */
export async function hydrateCivitaiApiKey(): Promise<void> {
  let stored: string | null
  try {
    stored = await secretGet(CIVITAI_KEY_ACCOUNT)
  } catch {
    return // no vault on this host
  }
  civitaiVaultReady = true
  if (stored) {
    useWorkflowStore.setState({ civitaiApiKey: stored })
    return
  }
  // Nothing in the vault. Read the CURRENT store value rather than a snapshot
  // taken before the await: a key typed while a locked keychain kept us waiting
  // must not be lost.
  const existing = useWorkflowStore.getState().civitaiApiKey?.trim()
  if (existing) {
    try {
      await secretSet(CIVITAI_KEY_ACCOUNT, existing)
    } catch {
      civitaiVaultFailed = true
    }
  }
  // Re-persist, so partialize can now strip the plaintext copy.
  useWorkflowStore.setState((s) => ({ ...s }))
}

export type WorkflowTagMode = 'image' | 'video'

export function workflowModelKey(
  modelName: string,
  mode: WorkflowTagMode,
): string {
  const normalisedName = modelName
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase()

  return `${mode}:${normalisedName}`
}

function normaliseTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

function validTagIds(
  tags: WorkflowTag[],
  requestedIds: string[],
): string[] {
  const existingIds = new Set(tags.map((tag) => tag.id))

  return [...new Set(requestedIds)]
    .filter((id) => existingIds.has(id))
}

function removeTagFromMap(
  assignments: Record<string, string[]>,
  tagId: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {}

  for (const [key, ids] of Object.entries(assignments)) {
    const remaining = ids.filter((id) => id !== tagId)

    if (remaining.length > 0) {
      next[key] = remaining
    }
  }

  return next
}

interface WorkflowState {
  installedWorkflows: WorkflowTemplate[]

  // Existing explicit workflow selections. These remain the source used when
  // generating; tag matches only determine which workflows are offered.
  modelTypeAssignments: Record<string, string>
  modelNameAssignments: Record<string, string>

  // Shared tag library and its workflow/model relationships.
  tags: WorkflowTag[]
  workflowTags: Record<string, string[]>
  modelTags: Record<string, string[]>

  civitaiApiKey: string
  civitaiHost: string

  /** One-time "new" dot on the Composer's workflow button. */
  managerNoticeSeen: boolean
  setManagerNoticeSeen: (v: boolean) => void

  installWorkflow: (wf: WorkflowTemplate) => void
  removeWorkflow: (id: string) => void

  assignToModelType: (modelType: string, workflowId: string) => void
  assignToModelName: (modelName: string, workflowId: string) => void
  unassignModelType: (modelType: string) => void
  unassignModelName: (modelName: string) => void

  createTag: (name: string) => string | null
  renameTag: (id: string, name: string) => void
  deleteTag: (id: string) => void

  setWorkflowTags: (workflowId: string, tagIds: string[]) => void
  setModelTags: (
    modelName: string,
    mode: WorkflowTagMode,
    tagIds: string[],
  ) => void

  getTagsForWorkflow: (workflowId: string) => WorkflowTag[]
  getTagsForModel: (
    modelName: string,
    mode: WorkflowTagMode,
  ) => WorkflowTag[]

  getMatchingWorkflows: (
    modelName: string,
    mode: WorkflowTagMode,
  ) => WorkflowTemplate[]

  getWorkflowForModel: (
    modelName: string,
    modelType: ModelType,
  ) => WorkflowTemplate | null

  setCivitaiApiKey: (key: string) => void
  setCivitaiHost: (host: string) => void
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      installedWorkflows: [],
      modelTypeAssignments: {},
      modelNameAssignments: {},

      tags: [],
      workflowTags: {},
      modelTags: {},

      civitaiApiKey: '',
      civitaiHost: 'civitai.com',

      managerNoticeSeen: false,
      setManagerNoticeSeen: (v) => set({ managerNoticeSeen: v }),

      installWorkflow: (wf) => set((state) => ({
        installedWorkflows: [
          wf,
          ...state.installedWorkflows.filter(
            (installed) => installed.id !== wf.id,
          ),
        ],
      })),

      removeWorkflow: (id) => set((state) => {
        const typeAssignments = { ...state.modelTypeAssignments }
        const nameAssignments = { ...state.modelNameAssignments }
        const workflowTags = { ...state.workflowTags }

        for (const [key, value] of Object.entries(typeAssignments)) {
          if (value === id) {
            delete typeAssignments[key]
          }
        }

        for (const [key, value] of Object.entries(nameAssignments)) {
          if (value === id) {
            delete nameAssignments[key]
          }
        }

        delete workflowTags[id]

        return {
          installedWorkflows: state.installedWorkflows.filter(
            (workflow) => workflow.id !== id,
          ),
          modelTypeAssignments: typeAssignments,
          modelNameAssignments: nameAssignments,
          workflowTags,
        }
      }),

      assignToModelType: (modelType, workflowId) => set((state) => ({
        modelTypeAssignments: {
          ...state.modelTypeAssignments,
          [modelType]: workflowId,
        },
      })),

      assignToModelName: (modelName, workflowId) => set((state) => ({
        modelNameAssignments: {
          ...state.modelNameAssignments,
          [modelName]: workflowId,
        },
      })),

      unassignModelType: (modelType) => set((state) => {
        const assignments = { ...state.modelTypeAssignments }
        delete assignments[modelType]

        return {
          modelTypeAssignments: assignments,
        }
      }),

      unassignModelName: (modelName) => set((state) => {
        const assignments = { ...state.modelNameAssignments }
        delete assignments[modelName]

        return {
          modelNameAssignments: assignments,
        }
      }),

      createTag: (name) => {
        const normalisedName = normaliseTagName(name)

        if (!normalisedName) {
          return null
        }

        const existing = get().tags.find(
          (tag) => tag.name.toLowerCase() === normalisedName.toLowerCase(),
        )

        if (existing) {
          return existing.id
        }

        const id = uuid()

        set((state) => ({
          tags: [
            ...state.tags,
            {
              id,
              name: normalisedName,
              createdAt: Date.now(),
            },
          ],
        }))

        return id
      },

      renameTag: (id, name) => {
        const normalisedName = normaliseTagName(name)

        if (!normalisedName) {
          return
        }

        set((state) => {
          const duplicate = state.tags.some(
            (tag) =>
              tag.id !== id &&
              tag.name.toLowerCase() === normalisedName.toLowerCase(),
          )

          if (duplicate) {
            return state
          }

          return {
            tags: state.tags.map((tag) =>
              tag.id === id
                ? { ...tag, name: normalisedName }
                : tag,
            ),
          }
        })
      },

      deleteTag: (id) => set((state) => ({
        tags: state.tags.filter((tag) => tag.id !== id),
        workflowTags: removeTagFromMap(state.workflowTags, id),
        modelTags: removeTagFromMap(state.modelTags, id),
      })),

      setWorkflowTags: (workflowId, tagIds) => set((state) => {
        const next = { ...state.workflowTags }
        const cleanedIds = validTagIds(state.tags, tagIds)

        if (cleanedIds.length > 0) {
          next[workflowId] = cleanedIds
        } else {
          delete next[workflowId]
        }

        return {
          workflowTags: next,
        }
      }),

      setModelTags: (modelName, mode, tagIds) => set((state) => {
        const next = { ...state.modelTags }
        const key = workflowModelKey(modelName, mode)
        const cleanedIds = validTagIds(state.tags, tagIds)

        if (cleanedIds.length > 0) {
          next[key] = cleanedIds
        } else {
          delete next[key]
        }

        return {
          modelTags: next,
        }
      }),

      getTagsForWorkflow: (workflowId) => {
        const state = get()
        const assignedIds = new Set(
          state.workflowTags[workflowId] ?? [],
        )

        return state.tags.filter((tag) => assignedIds.has(tag.id))
      },

      getTagsForModel: (modelName, mode) => {
        const state = get()
        const key = workflowModelKey(modelName, mode)
        const assignedIds = new Set(state.modelTags[key] ?? [])

        return state.tags.filter((tag) => assignedIds.has(tag.id))
      },

      getMatchingWorkflows: (modelName, mode) => {
        const state = get()
        const key = workflowModelKey(modelName, mode)
        const modelTagIds = new Set(state.modelTags[key] ?? [])

        if (modelTagIds.size === 0) {
          return []
        }

        return state.installedWorkflows
          .filter((workflow) => {
            if (
              workflow.mode !== 'both' &&
              workflow.mode !== mode
            ) {
              return false
            }

            const requiredTags =
              state.workflowTags[workflow.id] ?? []

            if (requiredTags.length === 0) {
              return false
            }

            // Every tag placed on a workflow is a compatibility requirement.
            // Models may have additional tags without preventing a match.
            return requiredTags.every((tagId) =>
              modelTagIds.has(tagId),
            )
          })
          .sort((left, right) => {
            const leftSpecificity =
              state.workflowTags[left.id]?.length ?? 0
            const rightSpecificity =
              state.workflowTags[right.id]?.length ?? 0

            if (leftSpecificity !== rightSpecificity) {
              return rightSpecificity - leftSpecificity
            }

            return right.installedAt - left.installedAt
          })
      },

      setCivitaiApiKey: (key) => {
        const trimmed = key.trim()
        set({ civitaiApiKey: trimmed })
        if (!civitaiVaultReady) return
        civitaiVaultFailed = false
        const write = trimmed
          ? secretSet(CIVITAI_KEY_ACCOUNT, trimmed)
          : secretDelete(CIVITAI_KEY_ACCOUNT)
        write.catch(() => {
          civitaiVaultFailed = true
          // Re-persist so partialize retains the localStorage fallback.
          set((s) => ({ ...s }))
        })
      },

      setCivitaiHost: (host) => set({
        civitaiHost:
          (host || 'civitai.com')
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/, '') ||
          'civitai.com',
      }),

           getWorkflowForModel: (modelName, modelType) => {
        const state = get()

        const mode: WorkflowTagMode =
          isVideoModelType(modelType)
            ? 'video'
            : 'image'

        const modelKey = workflowModelKey(
          modelName,
          mode,
        )

        const modelHasTags =
          (state.modelTags[modelKey]?.length ?? 0) > 0

        // Once a model has tags, only workflows satisfying all of their
        // compatibility requirements may be used.
        const compatibleWorkflowIds = modelHasTags
          ? new Set(
              state
                .getMatchingWorkflows(
                  modelName,
                  mode,
                )
                .map((workflow) => workflow.id),
            )
          : null

        const isAllowed = (workflowId: string) =>
          compatibleWorkflowIds === null ||
          compatibleWorkflowIds.has(workflowId)

        // Priority 1: explicit selection for this model.
        const nameId =
          state.modelNameAssignments[modelName]

        if (nameId && isAllowed(nameId)) {
          const workflow =
            state.installedWorkflows.find(
              (candidate) =>
                candidate.id === nameId,
            )

          if (workflow) {
            return workflow
          }
        }

        // Priority 2: legacy model-type assignment. This is retained for
        // existing installations, but it must also pass tag compatibility
        // after the model receives tags.
        const typeId =
          state.modelTypeAssignments[modelType]

        if (typeId && isAllowed(typeId)) {
          const workflow =
            state.installedWorkflows.find(
              (candidate) =>
                candidate.id === typeId,
            )

          if (workflow) {
            return workflow
          }
        }

        return null
      },
    }),
    {
      name: 'workflow-store',
      // The key is kept OUT of localStorage as soon as the OS vault has
      // proven itself and holds it. Until then, and on a host without one,
      // nothing changes: dropping it there would lose the key instead of
      // protecting it.
      partialize: (state) => {
        if (!civitaiVaultReady || civitaiVaultFailed) return state
        const { civitaiApiKey: _inTheVault, ...rest } = state
        return rest as WorkflowState
      },
    },
  ),
)

/**
 * Visibility rule for the one-time "new" dot on the Composer's workflow
 * button (David 2026-08-02: a minimal marker, not a banner), kept pure so it
 * is unit-testable. Local backend only — a custom ComfyUI workflow has
 * nothing to run on in cloud mode — and gone for good after the first click.
 * 'workflow-store' is in the AppShell backup key list, so that click survives
 * an NSIS update.
 */
export function shouldShowManagerNotice(
  backend: 'local' | 'cloud',
  managerNoticeSeen: boolean,
): boolean {
  return backend === 'local' && !managerNoticeSeen
}