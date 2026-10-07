# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through
[GitHub Security Advisories](https://github.com/jbcom/persistence-save/security/advisories/new),
which lets us discuss and fix the issue before it is disclosed.

You can expect an acknowledgement within a few days. If a fix is warranted, we
will prepare it privately, publish a patched release, and credit you in the
advisory unless you would rather remain anonymous.

## Supported versions

The latest `0.x` release receives security fixes. Older pre-1.0 releases are
not patched unless a coordinated disclosure requires an exceptional backport.

## In scope

Examples include malicious or corrupt save rows that escape isolation, snapshot
migrations that can be driven into an unbounded or non-terminating walk, SQLCipher
key handling, Preferences namespace collisions, package supply-chain issues, and
vulnerabilities in the package's runtime dependencies (sql.js and the jeep-sqlite
web component). What a game stores in its saves, and its own authorization and
game logic, are outside this repository's security boundary.
