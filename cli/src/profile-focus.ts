import { Effect } from "effect"
import type { JsonObject } from "./protocol.ts"

// Chrome has no tab-scoped permission command: these apply to the browser's default context, the most recently
// focused profile, whichever tab or session they're sent through.
const focusedProfilePermissionMethods = new Set([
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
])

/**
 * Refuses a permission command unless a window of the extension's profile has OS focus, so that with several
 * profiles in one Chrome the change can't land in another profile. An extension that can't report focus (one older
 * than the `windows.focusState` capability) keeps Chrome's last-focused-profile behaviour.
 */
export function guardFocusedProfilePermission(options: {
  readonly method: string
  readonly canReportFocus: boolean
  readonly focusState: () => Effect.Effect<JsonObject, Error>
}): Effect.Effect<void, Error> {
  if (!focusedProfilePermissionMethods.has(options.method) || !options.canReportFocus) return Effect.void
  return options.focusState().pipe(
    Effect.flatMap((state) => state.focused === true
      ? Effect.void
      : Effect.fail(new Error(
          `OpenCode Browser refused ${options.method}: Chrome applies permission changes to the most recently focused profile, `
            + "and no window of this session's profile is focused, so the change could land in another profile. "
            + "Ask the user to focus a window of this profile in Chrome, then retry.",
        ))),
  )
}
