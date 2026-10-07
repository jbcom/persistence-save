# Decisions

## 2026-10-07: extracted into its own repository

**Decision.** `@arcade-cabinet/persistence-save` moved out of
`Aethelgard-Chronicles-of-Strata/packages/persistence-save` into
`arcade-cabinet/persistence-save`, keeping its history (`git filter-repo
--subdirectory-filter`). Aethelgard now installs it from the registry.

**Why.** The owner: "You shouldn't need other games as dependencies for shared
packages." Published from inside a game, the package could only be released
through that game's lockfile and CI: 0.2.0 sat on Aethelgard's `main`
unpublished because the game's own lockfile broke its publish
(`ERR_PNPM_TARBALL_URL_MISMATCH`), while curse-of-the-mummy waited on 0.2.0's
`withConnection`, `flush` and `initializeSchema`.

## The repository shape follows lifecycle-kit

`ci.yml` runs `pnpm verify` on every push and pull request; `release.yml` runs
release-please and publishes from the tag. Biome replaces the formatter Aethelgard
applied at its root, configured to the style the source was already written in
(two spaces, single quotes, 100 columns) so the extraction did not reformat it.

## Toolchain: Node 26 and pnpm 12 to build, Node 24.19 as the floor to run

The fleet is moving to Node 26 and pnpm 12 (curse-of-the-mummy's toolchain lane),
so the repository builds there. The `engines` ceiling (`<25`) is gone, but the
floor stays at 24.19.0 and `@types/node` stays on 24: a library must not use an
API its oldest supported consumer lacks, and Aethelgard still ships on Node 24.

## Publishing uses `NPM_TOKEN`, not `GITEA_TOKEN`

Gitea 1.27 does not authorise package writes for the per-run Actions token
(lifecycle-kit's `release.yml` still uses it and has only ever been published by
hand). The publish step uses the CI organisation secret, fails closed
when it is empty, and removes it before the anonymous consumer proof runs.

## Publishing reconciles instead of reacting

The publish job does not key off release-please's `release_created` output for
the run that made the tag. On every `main` run it compares the manifest version
with the tags and the registry and publishes only what is tagged and missing,
after packing twice and requiring byte identity. Taken from curse-of-the-mummy's
`mobile-package` job: a failed publish is repaired by the next push instead of
leaving a tag with no package behind it.

## The first release is 0.2.0

The manifest starts at 0.1.2, the last version published from Aethelgard. Commits
imported from Aethelgard predate the bootstrap point, so release-please computes
the next version from this repository's own commits; the extraction lands as a
`feat`, so 0.1.2 becomes 0.2.0, the version Aethelgard's `main` already carried.

## Tests that read the host repository were rewritten, not dropped

Aethelgard's conformance test asserted its own root `package.json`, `.node-version`
and `ci.yml`. Those assertions now target this repository's own toolchain, CI and
release workflow. The assertion that Aethelgard consumes the package without a
second connection manager belongs to Aethelgard and moved there.
