/**
 * coi-serviceworker.js — cross-origin isolation shim for GitHub Pages
 *
 * GitHub Pages cannot serve custom HTTP headers. This service worker intercepts
 * navigation fetches and injects COOP + COEP headers so the browser considers
 * the page cross-origin isolated — enabling SharedArrayBuffer + WASM pthreads.
 *
 * COEP: credentialless (NOT require-corp) so HuggingFace CDN responses are
 * fetched without credentials and don't require an explicit CORP header.
 *
 * Spec refs:
 *   COOP  — https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-opener-policies
 *   COEP  — https://html.spec.whatwg.org/multipage/browsers.html#coep
 *   cred. — https://wicg.github.io/credentiallessness/
 */

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;

  // Skip non-GET — SW can't synthesize POST/PUT/etc responses
  if (req.method !== 'GET') return;

  // Skip 'only-if-cached' cross-origin (browser throws on these in SW context)
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  e.respondWith(
    fetch(req)
      .then(resp => {
        // Only add isolation headers to same-origin responses.
        // Cross-origin responses (CDN, fonts, etc.) are passed through unchanged.
        // COEP: credentialless on the page response is enough to enable isolation.
        if (resp.type !== 'basic') return resp;

        const headers = new Headers(resp.headers);
        headers.set('Cross-Origin-Opener-Policy',  'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        return new Response(resp.body, {
          status:     resp.status,
          statusText: resp.statusText,
          headers,
        });
      })
      .catch(() => fetch(req))
  );
});
