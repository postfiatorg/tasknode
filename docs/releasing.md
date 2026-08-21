# Releases and Production Deployments

The repository is the release unit. Do not export or maintain a separate
public-source candidate.

## Release requirements

1. Select a clean commit on protected public `main`.
2. Run the canonical checks and focused tests for changed boundaries.
3. Scan the exact checked-out filesystem with the pinned Gitleaks and
   TruffleHog versions used by CI.
4. Build web and worker images directly from that commit.
5. Record the Git SHA in image metadata and expose it through `/health`.
6. Deploy using `npm run fly:deploy:prod`; secrets remain in Fly's secret
   store and must never be copied into source or image layers.
7. Verify the production health response and the changed runtime boundary.

Git tags and release artifacts must point to the same public commit used by
production. SBOMs and attestations describe that repository state, not a
separate sanitized tree.
