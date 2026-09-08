# Profile picture quality and expansion

The public hero passed a CSS variable as its display size, which the shared
portrait component treated as a 48px avatar. It requested a 96px thumbnail for a
120px portrait, visibly undersampling high-density displays. Profile heroes now
request the original image eagerly and avoid thumbnail fallbacks. Small avatars
retain their existing thumbnail loading and cold-cache behavior.

Portraits, public/private NFT gallery images and completed Studio previews open
a native modal dialog. The full image fits within the viewport without cropping.
Close, Escape and backdrop dismissal restore focus to the trigger and release
the page scroll lock. The gallery selection action remains a separate button.

Verification: `scripts/profile-image-viewer-smoke.mjs` passed with actual React
components, a generated 1024×1536 test pattern and synthetic API responses. It
covers high-density desktop/mobile hero requests, all four expansion entry points,
original image dimensions, containment, native keyboard activation, Escape,
close/backdrop controls, focus/scroll restoration, selection isolation, failed
images and retained small-avatar thumbnails. No production writes or model calls.

Reproduce with a dedicated Vite instance on 5198 and Chrome CDP on 9358, then run
`node scripts/profile-image-viewer-smoke.mjs`. Optional `TASKNODE_APP_ORIGIN`,
`CDP_PORT` and `PROFILE_IMAGE_PROOF_DIR` configure the fixture; the last variable
writes screenshots/results to a scratch directory. Desktop and 390px mobile
screenshots were inspected. `npm run profile-nft-image-proxy-smoke`, ESLint on the
changed modules and `npm run build` also passed.


## Production deployment

Release **v727** completed on 2026-09-07, image
`registry.fly.io/tasknodeofficial-dev:deployment-01M1Y3Q2FXBW0DNVTYAQZ8VQ5B`.
The pre-change frontend matched all 67 deployed v726 files byte-for-byte. The
release adds only the profile image/viewer changes and profile documentation.
Its Docker layer overlays `dist` on the pinned v726 image; no backend, dependency,
migration or production configuration values changed.

The served HTML and new compiled assets match the reviewed release manifest.
Three concurrent health probes returned 200; the read-only background guard
verified all ten active process groups with their always-restart policy.

Browser verification used the actual production app and image endpoint. A
synthetic member-profile response supplied test identity/metadata because that
route requires a signed-in session; no real account session or private profile
was used. The real original image loaded at 1024×1024 with eager priority, opened
in the uncropped dialog, fit a 390px viewport and closed correctly. This verifies
the deployed presentation and image retrieval, not an authenticated member API
workflow. The dedicated browser process was stopped after verification.
