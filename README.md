# Task Node Official

Official product workspace for the Task Node application surface.

## Current Status

This repository is initialized with early product/interface artifacts:

- `product_spec.md` is present as the product specification placeholder. It is currently empty.
- `jsx_mock.jsx` contains a React mock for a ChatGPT-style Task Node interface with Tasks, Wallet, Context, Profile, Settings, and PFT balance surfaces.
- `login.jsx` contains a standalone login/sign-up modal mock with Telegram, Discord, X, and email entry options.

## Product Direction

The current mock positions Task Node as a clean chat-first interface with subtle product-specific surfaces:

- `Tasks` replaces project-style task management.
- `Wallet` exposes PFT balance and activity.
- `Context` provides internal and external context sources.
- Profile and settings surfaces support identity, security, billing, and data controls.

The next product step is to complete `product_spec.md` so implementation work can be tied to explicit requirements, milestones, and acceptance criteria.
