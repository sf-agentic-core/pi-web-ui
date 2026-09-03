/**
 * pi-web-ui — Progressive Web App service worker.
 *
 * Strategy overview
 * -----------------
 * pi-web-ui is a WebSocket-first app that needs a live backend, so we do NOT
 * try to make it fully offline. Instead the SW focuses on what makes it a
 * reliable *installable* PWA on mobile/desktop:
 *
 *   - network-first for navigation requests (falls back to the cached app
 *     shell when the network flaps), and
 *   - cache-first for hashed static assets, which Vite fingerprints so a cache
 *     hit is always the right version until a new deploy publishes new hashes.
 *
 * Real-time / dynamic / credential-bearing routes (/ws, /api, /themes,
 * /plugins) are always fetched from the network and never cached, so we never
 * risk serving stale theme/plugin code or caching anything sensitive.
 */

const STATIC_CACHE = "pi-web-ui-static-v1";
const SHELL_CACHE = "pi-web-ui-shell-v1";

self.addEventListener("install", (event) => {
	// Take control as soon as this version activates so the current page is
	// served by the new worker without requiring a second reload.
	self.skipWaiting();
	event.waitUntil(caches.open(SHELL_CACHE));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))),
			)
			// Apply to already-open pages immediately.
			.then(() => self.clients.claim()),
	);
});

// Only cache simple, safe GET requests. Everything else goes straight through.
function isCachable(request) {
	const method = request.method;
	if (method !== "GET") return false;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return false;

	// Never cache real-time, dynamic or credential/data endpoints.
	const path = url.pathname;
	if (path.startsWith("/ws") || path.startsWith("/api") || path.startsWith("/themes") || path.startsWith("/plugins")) {
		return false;
	}
	return true;
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (!isCachable(request)) {
		// Let the browser/backend handle WebSockets, API calls and cross-origin
		// requests normally.
		return;
	}

	const requestUrl = new URL(request.url);

	// Navigation → app shell. Network-first with cached fallback: users get the
	// latest build when online but can still reopen the app while flaky.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
					return response;
				})
				.catch(() => caches.match(request).then((cached) => cached || caches.match("/") || Response.error())),
		);
		return;
	}

	// Static assets (hashed by Vite) → cache-first.
	const isStatic =
		requestUrl.pathname.startsWith("/assets/") ||
		requestUrl.pathname.startsWith("/icons/") ||
		requestUrl.pathname === "/favicon.svg" ||
		requestUrl.pathname === "/icon.ico" ||
		requestUrl.pathname === "/manifest.webmanifest";

	if (isStatic) {
		event.respondWith(
			caches.match(request).then((cached) => {
				if (cached) return cached;
				return fetch(request).then((response) => {
					if (response && response.ok) {
						const copy = response.clone();
						caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
					}
					return response;
				});
			}),
		);
	}
});
