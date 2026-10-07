---
title: Decisions
description: Why the package is shaped the way it is.
---

## Open source under its own name

**Decision.** The package is published to npm as `persistence-save`, from
github.com/jbcom/persistence-save, MIT-licensed. Versions 0.2.0 and earlier were
published privately for the games that grew it; 0.2.1 is the first public
release, so no public version collides with a private one.

**Why.** Nothing in it is specific to one game or one machine, and a shared
package that only one private registry can serve cannot be adopted, reviewed or
reproduced by anyone else.

## Releases publish by OIDC from a verified tag

Release Please opens the release pull request. When it merges, `cd.yml` checks
out the release tag, runs the full `pnpm verify` again and publishes with
`npm publish --provenance` using GitHub's OIDC identity as an npm trusted
publisher. No long-lived npm token exists for this package, and the contract
test fails if one is ever referenced in a workflow.

## The packed consumer proves the tarball, not the source

`pnpm verify` ends by packing the package and installing that tarball into a
clean project with an empty home directory and only the public registry. It
exercises ESM, CommonJS and the type declarations from the installed copy, and
compiles both WebAssembly assets. Unit tests cannot see a missing `files` entry,
a broken `exports` map or a CommonJS build that only works inside the repo; this
can.

## The web component comes from jeep-sqlite-current-sqljs

The upstream `jeep-sqlite` package has not been published since 2.8.0. Its build
embeds the sql.js 1.11 loader but declares `sql.js ^1.11.0`, so a fresh install
resolves a newer sql.js, and the documented step of copying that version's
WebAssembly pairs the old loader with new wasm. That pairing fails to
instantiate (`LinkError` on an import). `jeep-sqlite-current-sqljs` is the same
upstream component with its loader and wasm rebuilt together on current sql.js,
pinned exactly, so they always match and the API is unchanged. It is pinned exactly here, together with sql.js, for the same reason.

## Toolchain: build on the current Node, run from the LTS floor

The repository builds on Node 26 and pnpm 12 with TypeScript 7. The published
package supports Node 24 and later (`engines.node: ">=24"`), and CI runs the
full gate on both.
