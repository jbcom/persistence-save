---
title: Contributing
description: Set up persistence-save, validate a change, and contribute it.
---

## Local workflow

```sh
mise install
pnpm install --frozen-lockfile
pnpm verify
pnpm docs:build
```

`pnpm verify` is the library gate: Biome, Markdown linting, strict TypeScript,
the tests with coverage, the ESM, CommonJS and type builds, `publint`, Are The
Types Wrong, and the packed-consumer proof. `pnpm docs:build` renders this site.

Branch from `main`, make a focused Conventional Commit, and open a pull request.
Release Please turns merged commits into the changelog and the next version;
never edit either by hand. See
[CONTRIBUTING.md](https://github.com/jbcom/persistence-save/blob/main/CONTRIBUTING.md)
for the review checklist.
