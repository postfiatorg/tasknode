# Task Node dark mode specification

Date: September 8, 2026
Status: Implemented September 8, 2026. See `docs/verification/dark-mode-2026-09-08.md` for verification scope and the embedded-editor limitation. The inventory below records the pre-implementation baseline.

## Product decision

Put the control in **account menu → Settings → General → Appearance**, using the Appearance row that already exists. Offer **System / Light / Dark** as three explicit, directly selectable options. Apply immediately, without Save, reload, or closing Settings.

Use the existing warm neutral visual language: charcoal surfaces, warm off-white text, restrained green/amber/red statuses, and clear surface boundaries. Preserve typography, density, spacing, and the identity of Hive and Profile.

Ship theme preference and complete first-party surface coverage together. A working switch with unreadable Wallet dialogs or a white Profile page is not complete dark mode.

## What exists today

This review inspected the local app source and route/style inventory, not an authenticated production browser tour.

| Finding | Source | Implication |
| --- | --- | --- |
| General already contains Appearance beneath the account-security callout | `src/features/settings/AppDialogs.jsx`, `GeneralSettings` | Reuse the existing settings location. |
| Appearance cycles `auto → light → dark` and changes its label | `nextTheme`, `themeLabel`, `CycleButton` in the same file | Replace hidden cycling with explicit choices. |
| App initializes `theme` to `auto` and only passes it to Settings | `src/app/App.jsx` | Preference is neither persisted nor applied to the document. |
| Global shell uses literal paper backgrounds and dark text | `src/styles-shell.css` | Setting a root class alone cannot recolor the app. |
| 36 CSS files contain approximately 2,323 hex/RGB literal occurrences | Static count of `src/**/*.css` on this date | This is a cross-surface color migration; the count is an inventory, not a count of defects. |
| Hive already has local `--hive-*` variables | `src/features/hive/hive-shell.css` | Map local roles to theme-aware aliases while retaining its identity. |
| Profile uses a JavaScript `C` palette and inline styles | `src/features/profile/profile-view-shared.jsx` and consumers | CSS-only selector overrides will miss these colors. |
| Docs Library has some `--bg`/`--text` fallbacks, but many hard-coded colors | `src/features/docs-library/docs-library.css` | Normalize onto one semantic contract rather than treating existing fallbacks as a theme system. |
| The document editor is an iframe | `src/features/docs-library/DocsLibraryView.jsx` | Parent CSS cannot theme the editor document; it needs its own integration. |
| Initial HTML has no theme bootstrap | `index.html`, `src/main.jsx` | Theme must resolve before the React app first paints. |
| CSP allows same-origin scripts but not ordinary inline scripts | `server/server-http-boundary.js` | Use a small external bootstrap; retain the current CSP. |
| Standalone Telegram auth pages explicitly use light mode | `server/auth-telegram-pages.js` | Include owned auth templates in the implementation inventory. |

## Settings interaction

Keep the four current tabs: General, Security, Data controls, Billing. In General, make Appearance the first settings row, above the security callout, so the control is immediately discoverable.

Proposed layout:

```text
Settings / General

Appearance                [ System | Light | Dark ]
Choose how Task Node looks on this device.

[Existing account-security callout]
```

Use a fieldset with legend “Appearance” and native radio inputs styled as a compact segmented control. The selected option gets a visible fill and check/selection treatment; labels remain visible. Clicking System selects System even if the current effective appearance is Dark. Arrow keys change the radio choice; Tab enters/exits the group normally. Focus remains on the chosen option.

At narrow widths, place the full-width three-option control beneath its label and description. Maintain approximately 44px touch targets and no horizontal overflow at 320px. Preserve Settings scroll position and open dialog state during a change.

Use text labels as the primary affordance; optional monitor/sun/moon icons are decorative. No separate dark-mode toggle elsewhere in v1. The current Contrast and Accent color rows are nonfunctional placeholders: they must not be wired into theme selection or imply that “Black” is the dark-mode setting. Cleaning up those placeholders is a separate settings decision.

## Preference and lifecycle contract

Proposed v1 scope is **this browser/device**, shared across accounts on this origin. Appearance should remain consistent through account switching and on the login screen. Cross-device account synchronization is deferred; no backend preference endpoint or migration is needed.

| State | Required behavior |
| --- | --- |
| No saved preference | System. Resolve from `prefers-color-scheme: dark`; use Light when unavailable. |
| Explicit Light or Dark | Override OS preference until the user changes it. |
| System selected | Follow OS changes live while the page is open. |
| Reload, deep link, browser restart | Restore the saved preference before the app paints. |
| Another tab changes preference | Apply through the storage event without reloading. |
| Storage access/write fails | Apply for this session; continue rendering normally. Do not claim persistence. |
| Invalid saved value | Treat as System; never apply arbitrary class or style values. |
| Legacy `auto` value | Normalize to `system` if encountered; current UI does not persist it. |
| Logout/account switch/account deletion | Retain the device appearance preference; it contains no account information. |
| User explicitly clears local site settings | Return to System. |

Storage key: `tasknode.appearance.v1`. Values: `system`, `light`, `dark`. Store the preference, not the effective color. Document state: `<html data-theme="light|dark" data-theme-preference="system|light|dark">`. Set the effective `color-scheme` as well, so native inputs and scrollbars agree with the app. [MDN: color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme).

Subscribe to the media query change event; apply it only while preference is System. Remove listeners when their owner is disposed. Use a stable application-level theme store, not per-route theme state. [MDN: matchMedia](https://developer.mozilla.org/en-US/docs/Web/API/Window/matchMedia).

## Bootstrap and implementation contract

1. Add a small same-origin, synchronous classic script in the document head, before the React module, for storage validation and initial theme resolution. Proposed file: `public/theme-init.js`. It must perform no network requests, access no account data, and catch storage/media-query errors.
2. Add shared semantic tokens and root canvas styling, loaded early enough to paint the resolved background. Proposed file: `src/styles-theme.css`, imported first by `src/styles.css`; verify built stylesheet order in `dist/index.html`.
3. Add the runtime preference store and React hook in `src/theme/`. Initialize from the bootstrap's normalized preference and resolved document state. Keep bootstrap/runtime normalization and precedence aligned with parity tests. The runtime owns subsequent writes and media/storage subscriptions.
4. Replace App's ephemeral theme state with that store; pass controlled preference/setter to GeneralSettings. Remove the unused cycle helper after checking consumers.
5. Define explicit light/dark token sets. For script-disabled or failed-bootstrap rendering, CSS should provide an OS-based fallback only when no explicit resolved attribute is present. Do not let a dark OS override explicit Light.
6. Set browser toolbar `theme-color` to match the effective canvas where supported. Do not use transitions on initial paint; v1 theme changes may be instantaneous.
7. Keep the bootstrap cache policy compatible with deployment: no long immutable cache for an unversioned `/theme-init.js`, or version the referenced asset. Check actual production headers and CSP rather than weakening the policy.

`color-scheme` handles browser-provided controls; it does not replace the app's authored palette. The root attribute must cover portals, modal backdrops, signed-out state, lazy-loaded routes, and public profile views.

## Color contract

Use semantic CSS properties instead of global find-and-replace by hex value. A literal white may mean text on a primary button, a panel, a QR-code background, or an image; those have different dark-mode behavior.

Core roles: `--tn-bg`, `--tn-sidebar`, `--tn-surface`, `--tn-surface-raised`, `--tn-surface-hover`, `--tn-text`, `--tn-text-secondary`, `--tn-text-muted`, `--tn-border`, `--tn-control-border`, `--tn-focus`, `--tn-link`, `--tn-primary-bg`, `--tn-primary-text`, `--tn-disabled-bg`, `--tn-disabled-text`, `--tn-backdrop`, and `--tn-shadow`.

Also define paired foreground/background tokens for success, warning, danger, information, selected rows, chat bubbles, inline code, code blocks, and diffs. A status color is not interchangeable with readable status text.

Starting palette, subject to rendered contrast validation:

| Role | Existing light reference | Proposed dark |
| --- | --- | --- |
| Canvas | `#FAF9F6` | `#171816` |
| Sidebar | `#F4F3EE` | `#1C1D1A` |
| Surface | `#FFFFFF` | `#22231F` |
| Raised surface | `#FFFFFF` | `#2A2B26` |
| Primary text | `#0D0D0D` | `#F2F0E9` |
| Secondary text | Surface-specific today | `#C5C3BA` |
| Muted readable text | Surface-specific today | `#A5A69A` |
| Decorative divider | `#E8E6DF` | `#3B3D35` |
| Interactive border | Surface-specific today | `#7B7E71` |
| Primary button | `#111111` / white text | `#E8E6DC` / `#171816` text |
| Focus indicator | Surface-specific today | `#B7D49C` |

Preserve existing light surface variations through semantic aliases. Hive's cream/green roles and Profile's paper/ink/rust roles may have distinct theme-specific values; they should not be flattened into identical gray cards.

For Profile, change CSS-compatible `C` values to `var(--tn-profile-...)` aliases. Inspect every consumer before doing so: CSS variables cannot be treated as hex strings, concatenated with alpha suffixes, or passed unresolved to canvas color APIs. Use explicit alpha tokens and resolve computed values for any canvas/chart renderer. Redraw those renderers when the theme changes.

## Surface coverage and file ownership

| Surface | Files / boundary to migrate | Required review states |
| --- | --- | --- |
| Shell, navigation, menus, loading/error boundaries | `styles-shell.css`, `styles-workspace.css`, App and shell components | Expanded/collapsed sidebar, mobile drawer, signed out, loading and failure |
| Chat and composer | `styles-chat.css`, `styles-composer.css`, `features/chat/chat-search.css` | Model menu, saved modalities, attachments, code/table/link output, streaming, empty/error, disabled Send |
| Settings, login, security, billing dialogs | `styles-settings.css`, `styles-dialogs-wallet.css`, settings/billing/identity components | Every tab, radios, destructive confirmation, unlock inputs, MFA callout |
| Tasks and task detail | Workspace rules plus all `features/tasks/*.css` | Status badges, sync notice, proposed/accepted/rewarded/refused, evidence forms, forensic tables |
| Wallet | `features/wallet/*.css` and wallet dialogs | Balances, addresses, transaction statuses, receive QR, top-up, locked/unlocked |
| Context and Memory | `features/context/*.css`, `features/memory/memory.css` | Editor/preview, selection, proposed edits, diffs, search and empty states |
| Hive | All `features/hive/*.css` | Boards, project detail, budget charts, chat, badges, tooltips and manager messages |
| Directory and Profile | Directory CSS, Profile palette/inline styles, image-viewer CSS | Own/public profile, badge layers, cards, portrait overlays, tables |
| Help and Docs Library | `features/docs/docs.css`, `features/docs-library/docs-library.css` | Navigation, markdown, folders, sharing, collaboration errors, editor loading and toolbar |
| Team and Messages extensions | `features/team/team.css`, `features/messages/messages.css`, extension inventory | Membership, invites, thread/composer, attachments and unread state |
| Owned standalone pages | `server/auth-telegram-pages.js`; inventory any other independently rendered templates | Login/link success, error and loading surfaces |

Treat responsive overrides as part of each migration: `src/styles-responsive.css` can reintroduce light backgrounds or dark text after an earlier token conversion. Audit embedded `<style>` blocks, inline JSX styles, SVG fills/strokes and background gradients too.

Images, NFT artwork, screenshots, evidence files and video retain their original pixels. Theme their frames and controls. QR codes keep a deliberate high-contrast light backing. Do not use page-wide inversion filters. Printed/exported artifacts retain an intentional print/export palette rather than inheriting an unreadable dark screen background.

### Embedded editor boundary

Task Node owns the editor toolbar and loading overlay, so those must support both modes. The iframe is a separate document; inspect its existing command/message protocol and owning repository before committing to editor-wide support. If it accepts a theme command, send only the resolved theme through the existing origin-validated bridge, resend on frame readiness, and verify changes while editing. Do not send wildcard-origin messages or inject CSS across origins. If it has no theme API, track editor theming as a companion change and disclose the light editor as an explicit release limitation. Third-party OAuth pages and user-uploaded documents remain outside Task Node's visual control.

## Accessibility and acceptance criteria

Normal text, including meaningful muted text and placeholders, must reach 4.5:1 contrast; large text may use 3:1. [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Meaningful control boundaries, selected-state indicators and focus cues must reach 3:1 against adjacent colors; decorative dividers do not have to serve as control boundaries. [W3C non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

Status remains understandable through text/icons, not color alone. Respect forced-colors mode and visible native focus behavior. Avoid global color transitions; no flashes or forced motion while changing preference.

Release checks:

- Unit coverage: valid/invalid storage, `auto` normalization, precedence, OS changes, storage failure, cross-tab changes, and bootstrap/runtime agreement.
- Browser coverage: real SettingsModal selection updates the document and representative surface colors immediately; keyboard and mobile control behavior; persistence through reload, logout and account switching.
- Cold-load checks: explicit Dark on a light OS and explicit Light on a dark OS, cold cache/throttled load, signed-out and direct deep links. Capture early frames to catch wrong-theme flashes and CSP failures.
- Both themes on every inventory row, including lazy-loaded routes opened after switching. Verify representative loading, empty, disabled, focused and error states.
- Desktop and mobile widths: 1440, 768, 390 and 320px. Inspect relevant dialogs at short viewport heights.
- Automated contrast checks plus manual review of statuses, charts, alpha overlays, Profile, code blocks and QR scans. Proposed palette values are not themselves proof of compliance.
- Existing light-mode screenshots remain visually equivalent except the intentional Appearance control placement. Theme changes preserve drafts, selection, scroll and active model requests.
- Run focused theme/browser tests, lint, production build and the existing appropriate UI checks. No paid LLM calls are needed to verify theme behavior.
- Before production release, use the normal Fly deployment wrapper and verify bootstrap asset headers, CSP, health and the actual served theme assets.

## Delivery sequence and effort

1. Theme tokens, bootstrap, runtime preference store and real Settings control.
2. Shared components and shell; Chat, Tasks, Wallet and all critical dialogs.
3. Hive, Profile/Directory, Context/Memory, Help/Docs, Team/Messages, standalone pages; resolve editor integration.
4. Full light/dark matrix, contrast corrections, cold-load verification and deployment.

Planning estimate: **5–8 focused engineering days for one engineer**, including validation; the external editor integration is additional if its protocol needs changes. This estimate comes from the current style inventory and should be revised after the first representative shell/settings/chat conversion. Keep a per-surface checklist; do not equate token introduction with complete coverage.

The original specification task did not include runtime changes. The subsequent implementation is tracked in the verification document linked above.
