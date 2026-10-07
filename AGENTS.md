# Agent notes

This file is for an autonomous coding agent working in this repository. It covers
what isn't obvious from reading the code alone.

## Toolchain

- Package manager: pnpm, pinned in `package.json#packageManager`. Use
  `mise install` (reads `mise.toml`), or `npm install --global corepack &&
  corepack enable` (Node 25+ no longer bundles Corepack).
- This is a pnpm workspace with two members: `.` (the published library) and
  `docs/` (the private Sourcey documentation site). `pnpm docs:*` scripts
  delegate to `docs/` via `pnpm --filter persistence-save-docs`.
- `pnpm verify` is the single gate CI runs: Biome, markdownlint, strict
  TypeScript, the tests with coverage, the ESM, CommonJS and type builds,
  `publint`, Are The Types Wrong, and the packed-consumer proof. A change is not
  done while any part of it is red.

## Core invariants

Read `docs/ARCHITECTURE.md` before editing `src/`. In short: parameterized SQL
only; corruption is never reported as "no save"; migrations are exact pure
`N → N+1` steps; reads never write; inputs are bounded before parsing; every web
write is flushed before it resolves; encryption fails closed; one connection
manager.

## Keeping docs and tests in sync

A change to the public surface needs matching updates in `tests/`, `docs/API.md`,
`docs/ARCHITECTURE.md` when it crosses a module boundary or invariant, and
`README.md` when it affects the quick start.

## Commits and releases

- Conventional Commits only. Release Please drives `CHANGELOG.md` and the version
  from the merge history; never edit either by hand.
- `simple-git-hooks`, `lint-staged` and `commitlint` run on `pre-commit` and
  `commit-msg` after `pnpm install`. Don't bypass them with `--no-verify`.
- Publishing happens only in `cd.yml`, by OIDC, from a verified release tag.

## Files most likely to surprise you

- `scripts/verify-packed-consumer.mjs` runs pnpm with an empty home directory and
  a throwaway npmrc. It requires the exact pnpm version in `packageManager`.
- The sql.js and `jeep-sqlite-current-sqljs` versions are pinned exactly on
  purpose: the shipped WebAssembly must match what the component loads.
- `pnpm-workspace.yaml`'s `allowBuilds` controls which install scripts run.
