# App Extensions

Task Node has a small build-time extension registry for secondary application
surfaces. A contributor can add a lazy-loaded page and a **More** menu entry in
`src/extensions/builtins.jsx` without editing `src/main.jsx` or the central
router. The registry validates identifiers, rejects duplicates, orders entries
deterministically, supports runtime feature gates, and keeps authentication
intent explicit.

An extension definition contains:

- `id`: stable lowercase route identifier;
- `label` and `icon`: navigation presentation;
- `component`: normally a lazy React component;
- `menu`, `group`, and `order`: deterministic placement;
- `requiresAuth`: whether navigation should open login for signed-out users;
- `enabled(context)`: a side-effect-free runtime feature gate; and
- `props(context)`: the narrow host capabilities passed into the page.

Extensions are compiled and reviewed with the application. This is not an
arbitrary remote-code or npm-plugin loader: a public marketplace would require
package signing, capability permissions, origin isolation, and a separate
threat model. Host context should remain narrow; do not pass credentials,
wallet seed material, raw database access, or operator capabilities.

Run `npm run extension-registry-smoke` after changing the contract. The normal
build proves every registered lazy import resolves.
