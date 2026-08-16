# Third-Party Notices

Task Node distributes npm dependencies identified exactly by `package-lock.json`.
The release SBOM is generated from that lockfile in both CycloneDX and SPDX
formats. `npm run dependency-license-check` fails when a dependency has missing
or unreviewed license metadata.

The reviewed dependency license families are 0BSD, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, CC-BY-4.0, CC0-1.0, ISC, LGPL-3.0-or-later, MIT, MPL-2.0,
Python-2.0, and Unlicense, including the compound expressions recorded in the
lockfile.

Important distribution obligations include:

- `sharp` platform packages distribute libvips under LGPL-3.0-or-later; the
  corresponding package source, license, and relinking rights must remain
  available in distributed images.
- `lightningcss`/`axe-core` packages use MPL-2.0; modifications to covered files
  must remain available under MPL-2.0.
- `caniuse-lite` includes CC-BY-4.0 data and requires attribution.

This summary is not a replacement for the license texts shipped in dependency
packages or the exact release SBOM. The public candidate must retain those
files and archive both SBOM outputs with the image provenance record.

Non-code project assets are separately enumerated and hashed in
`provenance/assets.json`; project marks remain governed by `TRADEMARKS.md`.
