/**
 * Service availability announcements — "the restart/deploy is done, you can keep
 * working".
 *
 * pi-web-ui is WebSocket-first, so a deployment (or any restart) means the page
 * silently loses its connection and gets it back a few seconds to a few minutes
 * later, with nothing to tell the user that the service is usable again.
 *
 * Two independent planes cover that, and they never coordinate:
 *
 *   - **This module** (the page is alive): the socket comes back. Also carries
 *     the sound cue, because audio needs a page.
 *   - **Web Push** (nothing is alive): the server announces itself at boot and
 *     the service worker shows a system notification — except when a window is
 *     open, in which case it stays silent and lets the page do it, so a single
 *     restart never produces two toasts.
 *
 * The decision is a pure function so the awkward cases are pinned by tests: a
 * plain page reload must stay quiet, while reloading *during* an outage — the
 * case this exists for — must still say something. That is why the rule is not
 * just "ready came back", but also "the build changed since this browser last
 * ran it".
 */

/** The version this browser last saw running, for the "it was updated" cue. */
export const LAST_SEEN_VERSION_KEY = "pi-web-ui:app-version";

export type AvailabilityKind = "online" | "updated";

export interface AvailabilityAnnouncement {
	/** `online` = same build came back; `updated` = the build itself changed. */
	kind: AvailabilityKind;
	version: string;
	/** The version this browser saw before, when known (empty otherwise). */
	previousVersion: string;
}

export interface AvailabilityInput {
	/** `ready` before this update. */
	wasReady: boolean;
	/** `ready` now. */
	isReady: boolean;
	/** Has this page ever reached `ready`? (A fresh load has not.) */
	sawReadyBefore: boolean;
	/** `appVersion` reported by the server (empty when unknown). */
	version: string;
	/** Persisted version from the previous visit (empty on a first visit). */
	lastSeenVersion: string;
}

/**
 * Should this `ready` transition be announced, and as what?
 *
 * Returns null when there is nothing worth saying. A transition *out of* ready
 * is deliberately ignored: this feature only tells the user when they can work
 * again (a "service is down" signal cannot come from the service itself, and
 * inferring one from a dropped socket means crying wolf on every laptop suspend
 * and Tailscale blip).
 */
export function decideAvailabilityAnnouncement(input: AvailabilityInput): AvailabilityAnnouncement | null {
	// Only the transition into "ready": `ready` is also re-set on every snapshot,
	// and a notification per state update would be unusable.
	if (input.wasReady || !input.isReady) return null;

	const version = input.version.trim();
	const previousVersion = input.lastSeenVersion.trim();
	const versionChanged = version !== "" && previousVersion !== "" && version !== previousVersion;

	// A changed build is the more informative message of the two, and it is also
	// what catches "I reloaded while the service was down": that page never saw an
	// earlier `ready`, so the reconnect rule alone would stay silent exactly when
	// the user is waiting to hear something.
	if (versionChanged) return { kind: "updated", version, previousVersion };
	if (input.sawReadyBefore) return { kind: "online", version, previousVersion };
	// First load of an already-healthy page on a known build: nothing happened.
	return null;
}

/** Last version this browser ran (empty when unknown or storage is unavailable). */
export function loadLastSeenVersion(): string {
	try {
		return localStorage.getItem(LAST_SEEN_VERSION_KEY) ?? "";
	} catch {
		return "";
	}
}

/** Remember the running version so a later reload of the same build stays quiet. */
export function saveLastSeenVersion(version: string): void {
	try {
		if (version.trim() !== "") localStorage.setItem(LAST_SEEN_VERSION_KEY, version.trim());
	} catch {
		// private mode / storage full — the worst case is one extra announcement
	}
}
