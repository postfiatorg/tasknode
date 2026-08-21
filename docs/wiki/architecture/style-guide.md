# Style Guide

Task Node should feel like a quiet work instrument: dense, readable, calm, and consistent. The interface is not a landing page, a dashboard demo, or a decorative crypto app. It should help a user understand what state they are in, what changed, and what action is available next.

## Design Principles

- Prefer clarity over decoration. State, proof, and next action should be visible before visual flourish.
- Use the same visual language across Chat, Tasks, Hive, Wallet, Context, Profile, Memory, and Docs.
- Keep cards and panels restrained. Do not nest cards inside cards unless the inner card is a repeated item, modal, or proof object.
- Use color for state and meaning, not ornament.
- Avoid gradients, decorative blobs, oversized marketing heroes, and one-off tinted panels.
- Keep typography compact. Large type is for page-level headings, not controls or dense panels.

## Core Palette

| Token | Value | Use |
| --- | --- | --- |
| App background | `#faf9f6` | Main workspace and full-pane task detail surfaces. |
| Sidebar background | `#f4f3ee` | Left navigation and low-emphasis strips. |
| Raised surface | `#ffffff` | Inputs, modals, cards, popovers, and active field areas. |
| Soft surface | `#fbfaf7` | Read-only panels, file drop zones, neutral helper callouts. |
| Border/rule | `#e8e6df` | Primary borders and separators. |
| Soft rule | `#e4e0d4` | Interior section dividers. |
| Primary ink | `#1b1b19` | Main text and active tabs. |
| Body ink | `#3a3936` | Paragraph text in dense panels. |
| Muted ink | `#6e6b62` | Labels, helper text, inactive controls. |
| Faint ink | `#8e8b81` | Secondary metadata, placeholder-like values. |
| Primary action | `#0d0d0d` | Main filled buttons only. |

## Semantic Colors

| Meaning | Color | Notes |
| --- | --- | --- |
| Success / paid / complete | `#4a5934` or `#166534` | Use sparingly for completed states and positive confirmations. |
| Verification / active review | `#5b4b8a` | Use for verification-requested task glyphs and state dots. |
| Warning / partial / blocked | `#6e5223` | Use for actual caution states, not general helper copy. |
| Error / destructive | `#7c2d12` or `#8c3a28` | Use for failures, refusal/cancel risk, and destructive states. |
| Live / available | `#10a37f` | Small status dots or compact live labels only. |

Do not introduce new surface tints without adding them here. A one-off tan, blue, purple, or green panel usually means the component is escaping the app language.

## Typography

- Primary app font is system UI through `Inter, system-ui, sans-serif`.
- Page headings should usually be `24px` to `34px` depending on surface density.
- Panel headings should be `13px` to `16px`, medium weight.
- Metadata should be `11px` to `13px`, muted, and readable.
- Letter spacing should be `0` except for small uppercase labels, where `0.04em` to `0.06em` is acceptable.

## Layout

- The app shell keeps the left navigation fixed and lets the current surface own the remaining workspace.
- Full-screen replacement views should be avoided inside desktop surfaces. Prefer in-place panes that cover the active workspace while keeping navigation visible.
- Repeated cards use `8px` to `14px` radius depending on density. Do not use large pill-like card corners for normal content.
- Section spacing should be predictable: `16px`, `24px`, `32px`, and `48px` are the default rhythm.
- Dense operational surfaces should use dividers and whitespace before additional card chrome.

## Buttons And Controls

- Filled black buttons are primary actions: submit evidence, request task, save, publish, unlock.
- Light pills are secondary actions: copy, add evidence, close, expand, restore.
- Icon buttons should use Lucide icons and include accessible labels or visible text when the action is not obvious.
- Disabled buttons must visibly dim and should not be replaced by hidden behavior.
- File inputs must not expose the browser default `Choose File` button. Wrap them in app-styled controls.

## Surface Guidance

### Chat

Chat is the primary working surface. It should feel conversational but operational. Copy controls are subtle. Markdown must render lists, paragraphs, code, and tables cleanly. The composer owns action modes such as Context Refine and Request Task without creating separate decorative surfaces. Hive is a dedicated default chat, not a temporary `+` menu mode.

### Tasks

Tasks are lifecycle objects. The user should always see the current state, the current requirement, and the next available action. Task detail opens as an in-place workspace pane on desktop. Submit uses white fields, neutral soft panels, and the same border system as Overview and Forensics. Verification requirements take priority over original task history; older context can be expanded.

### Hive

Hive is a network coordination board, not a social feed. Project cards should show project purpose, phase, task counts, contributors, and routing state. Activity feeds should be compact and ordered newest first. Empty projects should look actionable, not complete.

### Wallet

Wallet is custody and proof infrastructure. Use sober state language: linked, locked, unlock pending, unlocked, vault missing. Wallet unlock controls should be visible at the point of need and should not force users to leave their current task flow.

### Context

Context is a durable working profile. Editing should feel like writing in a quiet document tool. Revision history should distinguish cached previews from published PFT pointers. Line numbers are a tool, not decoration, and must be optional.

### Profile

Profile has private and public modes. Private profile emphasizes airdrops, task rewards, NFT generation, and contributor self-understanding. Public profile emphasizes trust and discoverability. Avoid social-feed mechanics unless a future product decision explicitly adds them.

### Memory

Memory must be auditable. Generated memory, deep memory, live task context, and network task profile should have clear source boundaries. Avoid raw JSON dumps unless the user explicitly opens an audit/debug view.

### Docs

Docs are the canonical human-readable map of the app. Every major surface should explain what exists now, what data backs it, and where the code lives. Docs should not imply vaporware is operational. Do not leave generic reviewer to-do lists in product docs; either run the review and record dated evidence, or mark the workflow as a current limit, deprecated, or not exposed.

## Review Checklist

Use this checklist before shipping visible UI:

- [ ] Page background, panel background, borders, and input fills match the core palette.
- [ ] No new gradient, decorative orb, or one-off tinted panel was introduced.
- [ ] The current state and next action are clear without reading implementation details.
- [ ] Buttons use the primary/secondary hierarchy consistently.
- [ ] File, screenshot, and upload controls hide native browser chrome.
- [ ] Text fits at desktop and mobile widths.
- [ ] Screenshots were taken for the changed surface.
- [ ] The relevant docs page was updated when behavior changed.
