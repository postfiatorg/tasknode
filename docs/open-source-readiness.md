# Open-Source Status

Status: **canonical production source is public**

Task Node uses one application repository. The source in this repository is
the source used to build the hosted product at `https://tasknode.postfiat.org`.
Production configuration is represented by `fly.toml` and `ops/`; credentials,
signing material, user records, and runtime state are injected by the hosting
platform and are not source files.

## Required invariants

- Production images are built only from protected public `main` commits.
- `/health` and deployment metadata identify the exact source commit.
- Application logic, migrations, workers, prompts, and operator executables are
  reviewed in this repository; there is no private application-code superset.
- Secrets and user data never enter Git.
- Gitleaks and TruffleHog scan the exact source tree before publication or
  deployment.
- Internal evidence, incident payloads, and unfinished plans live outside this
  repository and are not required to build or operate the product.

## Verification

At minimum, changes to the publication or deployment boundary must pass:

```bash
npm ci
npm run lint
npm run build
npm run migration-registration-smoke
npm run container-entrypoint-smoke
```

Run the focused smoke tests for every changed product boundary. Release and
deployment instructions are in [`releasing.md`](releasing.md).
