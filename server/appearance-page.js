// Shared head fragment for first-party pages rendered outside the React shell.
export const appearancePageHead = `
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#faf9f6">
<script src="/theme-init.js"></script>
<script src="/theme-page.js" defer></script>
<style>
:root[data-theme="dark"] { color-scheme: dark; background: #171816; color: #f2f0e9; }
:root[data-theme="dark"] body { background: #171816; color: #f2f0e9; }
:root[data-theme="dark"] main { background: #22231f; border-color: #3b3d35; }
:root[data-theme="dark"] p { color: #c5c3ba; }
:root[data-theme="dark"] .muted { color: #a5a69a; }
:root[data-theme="dark"] .step, :root[data-theme="dark"] code { background: #2a2b26; border-color: #3b3d35; }
:root[data-theme="dark"] .button { color: #171816; background: #e8e6dc; }
:root[data-theme="dark"] a:focus-visible { outline: 2px solid #b7d49c; outline-offset: 3px; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { color-scheme: dark; background: #171816; color: #f2f0e9; } }
</style>`;
