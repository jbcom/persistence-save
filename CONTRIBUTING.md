# Contributing

Thanks for taking the time to contribute.

## Getting set up

With [mise](https://mise.jdx.dev) (recommended; it installs the Node and pnpm
versions pinned in `mise.toml`):

```sh
mise install
pnpm install
pnpm verify   # lint, docs lint, typecheck, coverage, build, package checks, packed consumer
```

Without mise, use Corepack so pnpm matches `package.json#packageManager`, on any
Node release in the `engines.node` range (`>=24`; CI verifies 24 and 26). Node 25
and later no longer bundle Corepack, so install it once:

```sh
npm install --global corepack
corepack enable
pnpm install
pnpm verify
```

## Making a change

1. Branch off `main`.
2. Write the test first. A bug fix comes with a test that fails without it.
3. Run `pnpm verify`. A change is not ready while any part of it is red.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org):
   `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`. Release Please uses
   these commits to drive the changelog and the next version.
5. Open a pull request describing what changed and why.

## What gets reviewed

- Does it do what it says, and is there a test proving it?
- Does it keep the public API honest? A breaking change needs a `!` or a
  `BREAKING CHANGE:` footer.
- Are the types right for consumers? CI runs `publint` and
  `arethetypeswrong`, because broken types only surface at integration time.
- Do invalid snapshots, versions and migrations fail as typed errors before
  anything is written?
- Does the packed consumer still pass, so the published tarball works in a clean
  project under both ESM and CommonJS?

## Releases

Releases are automated. Merging a conventional commit to `main` opens a release
pull request; merging that publishes to npm with provenance. Do not hand-edit
versions or the changelog.
