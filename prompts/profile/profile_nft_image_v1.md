---
name: profile-nft-image
model: gpt-image-2
temperature: 0.7
max_tokens: 4000
---

@@@SYSTEM@@@
Create a square profile NFT image from the supplied Task Node execution context.

The image is a public work-identity artifact. It should feel personal, high-signal, and visually rich without exposing private details. The user should recognize their work, judgment, and current direction in the image, but the image must not contain readable text or sensitive identifiers.

Use a full color palette. Do not default to red and black, cyber-noir, monochrome ink, or any fixed brand palette. Choose colors from the whole spectrum based on the user's actual context, recent tasks, role, and requested style. Each generation should feel color-distinct unless the user explicitly asks for a repeated style.

@@@USER@@@
Create a square, high-detail profile NFT image representing the user's current work identity.

Primary composition:
- Create one central avatar, persona, or work figure with a readable silhouette.
- The figure should be doing something implied by the user's work: building, deploying, trading, designing, coordinating, debugging, signing, routing, validating, researching, teaching, or verifying.
- The action should define the figure. Do not make a scattered dashboard collage, flowchart, symbolic diagram, or generic background scene.
- The image must still read clearly at profile-picture size: head, torso, hands, tools, or posture first; fine detail second.

Color direction:
- Use full-spectrum color. Consider emerald, cobalt, amber, violet, cyan, magenta, coral, gold, silver, white, graphite, rose, teal, and other context-fit colors.
- Choose one dominant palette and one or two accent colors from the user's context. The palette may be bright, muted, warm, cool, metallic, organic, technical, or ceremonial.
- Red and black may appear, but they must not be the default dominant palette. Use red or black dominance only when the supplied context or requested style clearly calls for it.
- Avoid identical-looking outputs across users. If the context is different, the palette should feel different.
- Keep enough contrast for profile use, but do not turn contrast into automatic black-heavy styling.

Reference block handling:
- Use the references for visual meaning, not literal text.
- Do not render words, labels, UI text, wallet addresses, emails, handles, private names, raw task IDs, or raw task titles in the image.
- Convert sensitive or identifying details into abstract symbols, tools, architecture, materials, motion, posture, and composition.
- Do not display private keys, seed phrases, secrets, exact balances, or account identifiers.

Style:
- Make it sophisticated, specific, and visually memorable.
- Prefer rich illustration, material texture, precise lighting, and clear composition.
- Avoid corporate clipart, flat SaaS illustration, generic avatars, mascots, stock art, random monster faces, illegible clutter, and glossy 3D toy rendering.
- No text in the image ever.

<NFT_CONTEXT_HYDRATION>
___NFT_USER_DATA_REPLACED_HERE___
</NFT_CONTEXT_HYDRATION>

<USER_CONTEXT_DOCUMENT_DIRECT>
___USER_CONTEXT_DOCUMENT_CONTENT_REPLACED_HERE___
</USER_CONTEXT_DOCUMENT_DIRECT>

Boot string:
< insert Random String>
