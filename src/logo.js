// Original app embedded the logo as a base64 data URI string baked into the JS bundle.
// Here it's a real file (public/logo.png) referenced by URL - same visual result, without a
// 106KB string literal in every bundle. Built via BASE_URL (not a hardcoded "/logo.png") because
// this string gets inserted into the DOM at runtime, not parsed from index.html, so Vite's
// base-path rewriting never sees it - it would 404 under a non-root `base` (e.g. GitHub Pages
// project sites at /<repo-name>/) otherwise.
export const LOGO_IMG = `<img src="${import.meta.env.BASE_URL}logo.png" alt="Hypermedia" style="width:100%;height:100%;object-fit:contain;display:block;"/>`;
