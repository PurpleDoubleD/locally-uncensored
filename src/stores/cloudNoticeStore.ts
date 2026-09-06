import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeJSONStorage } from "../lib/storage-quota"

/**
 * How long a cloud render stays retrievable. Single source of truth for the
 * copy so the number never drifts between surfaces.
 *
 * Server side: `RESULT_SIGNED_URL_TTL_SEC` defaults to 604800 (7 days), which
 * is the signed URL lifetime, and the desktop silently re-signs an expired one
 * via the job id (galleryUrl.ts refreshResultUrl). Actually DELETING the
 * results bucket on that schedule is a server job David owns and operates in
 * lu-labs (his call, 2026-07-25) — the desktop's part is stating the policy,
 * which is what this notice does. If the sweep is ever turned off, this copy is
 * the thing that has to change, not the other way round.
 */
export const CLOUD_RETENTION_DAYS = 7;

/**
 * Gallery retention notice for cloud mode (David 2026-07-24). Shown while the
 * Create surface is on the cloud backend so nobody treats the cloud gallery as
 * permanent storage.
 *
 * `retentionNoticeSeen` (persisted) is the ONLY thing that hides it, and it is
 * once ever: no auto-hide, no close X, and it does NOT come back after an
 * update. Dismissing is a deliberate click on "Do not show again", matching the
 * one-time-onboarding rule the Try local / Try cloud popups follow.
 */
interface CloudNoticeState {
  retentionNoticeSeen: boolean;
  setRetentionNoticeSeen: (v: boolean) => void;
}

export const useCloudNoticeStore = create<CloudNoticeState>()(
  persist(
    (set) => ({
      retentionNoticeSeen: false,
      setRetentionNoticeSeen: (v) => set({ retentionNoticeSeen: v }),
    }),
    {
      name: "lu_cloud_notice",
      storage: safeJSONStorage(),
    },
  ),
);

/**
 * Visibility rule for the retention notice, kept pure so it is unit-testable
 * (the JSX condition would otherwise only be provable via a live E2E). Cloud
 * backend only — a local render never leaves the machine, so the warning would
 * be a lie there — and never again once dismissed.
 */
export function shouldShowRetentionNotice(
  backend: "local" | "cloud",
  retentionNoticeSeen: boolean,
): boolean {
  return backend === "cloud" && !retentionNoticeSeen;
}
