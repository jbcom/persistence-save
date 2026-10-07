// Applies the jbcom OSS ruleset trio to a repository, idempotently (PUT by name, POST when absent):
//   main-integrity        default branch: PR only, merge commits, threads resolved, checks green and up to date,
//                         no deletion or force-push
//   conventional-commits  every other branch: commit messages are Conventional Commits, so release-please can
//                         read the merged history. No Copilot review or Code Quality rule: both spend AI credits
//                         even on public repositories (owner 2026-10-07; GitHub billing docs).
//   release-tag-integrity tags: release-please tags never move or disappear
// Usage: node <path-to-this-script> <repo> '<check context>[;<check context>...]'
import { execFileSync } from 'node:child_process';

const [
  repo = 'persistence-save',
  checksArg = 'CI / gate;title;Repository Policy / gate;Dependency Review / gate',
] = process.argv.slice(2);
if (!repo || !checksArg)
  throw new Error(`usage: node ${process.argv[1]} <repo> <checks;semicolon;separated>`);
const REPO = `jbcom/${repo}`;
// Semicolon-separated: check names such as "Verify (ubuntu-24.04, Node 26)" contain commas.
const checks = checksArg.split(';').map((context) => ({ context }));

const rulesets = [
  {
    name: 'main-integrity',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['merge'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, required_status_checks: checks },
      },
    ],
    bypass_actors: [],
  },
  {
    name: 'conventional-commits',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~ALL'], exclude: ['~DEFAULT_BRANCH'] } },
    rules: [
      {
        type: 'commit_message_pattern',
        parameters: {
          name: 'Conventional Commits',
          operator: 'regex',
          pattern:
            '^(Merge |Revert "|(feat|fix|docs|chore|refactor|perf|test|ci|build|style|revert)(\\([^)]+\\))?!?: )',
          negate: false,
        },
      },
    ],
    bypass_actors: [],
  },
  {
    name: 'release-tag-integrity',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }],
    bypass_actors: [],
  },
];

// Repository mutation endpoints cannot edit inherited organization/enterprise rules.
const existing = JSON.parse(
  execFileSync('gh', ['api', `repos/${REPO}/rulesets?includes_parents=false`], {
    encoding: 'utf8',
  }),
).filter((ruleset) => ruleset.source_type === 'Repository');
// The superseded non-main ruleset carried the AI-billed Code Quality rule.
for (const stale of existing.filter((r) => r.name === 'pull-request-review')) {
  execFileSync('gh', [
    'api',
    `repos/${REPO}/rulesets/${stale.id}`,
    '--method',
    'DELETE',
    '--silent',
  ]);
  console.log(`${REPO}: pull-request-review deleted`);
}
for (const ruleset of rulesets) {
  const current = existing.find((r) => r.name === ruleset.name);
  const endpoint = current ? `repos/${REPO}/rulesets/${current.id}` : `repos/${REPO}/rulesets`;
  execFileSync(
    'gh',
    ['api', endpoint, '--method', current ? 'PUT' : 'POST', '--input', '-', '--silent'],
    {
      input: JSON.stringify(ruleset),
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  console.log(`${REPO}: ${ruleset.name} ${current ? 'updated' : 'created'}`);
}
