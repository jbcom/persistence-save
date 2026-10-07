#!/usr/bin/env node
// release-please finds a merged release PR by its `autorelease: pending` label. Gitea does not
// create labels on first use, so on a repository without them the label write fails silently, the
// merge is never tagged, and the next run computes a bogus release. Run before release-please.
// Needs GITEA_TOKEN, GITEA_SERVER_URL and GITEA_REPOSITORY (owner/name).
const { GITEA_TOKEN, GITEA_SERVER_URL, GITEA_REPOSITORY } = process.env;
if (!GITEA_TOKEN || !GITEA_SERVER_URL || !GITEA_REPOSITORY) {
  throw new Error('GITEA_TOKEN, GITEA_SERVER_URL and GITEA_REPOSITORY are required');
}

const api = `${GITEA_SERVER_URL}/api/v1/repos/${GITEA_REPOSITORY}`;
const headers = { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' };
const definitions = [
  {
    name: 'autorelease: pending',
    color: 'fbca04',
    description: 'Release pull request awaiting tag and Gitea release creation',
  },
  {
    name: 'autorelease: tagged',
    color: '0e8a16',
    description: 'Release pull request whose tag and Gitea release were created',
  },
];

async function failure(response, what) {
  return new Error(`${what} returned ${response.status}: ${await response.text()}`);
}

async function labelNames() {
  const names = new Set();
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${api}/labels?limit=50&page=${page}`, { headers });
    if (!response.ok) throw await failure(response, `label inventory page ${page}`);
    const labels = await response.json();
    for (const label of labels) names.add(label.name);
    if (labels.length < 50) return names;
  }
}

const existing = await labelNames();
for (const definition of definitions) {
  if (existing.has(definition.name)) continue;
  const created = await fetch(`${api}/labels`, {
    method: 'POST',
    headers,
    body: JSON.stringify(definition),
  });
  if (created.ok) {
    console.info(`label ${definition.name}: created`);
    continue;
  }
  // A concurrent run may have created it after the inventory; only that is tolerated. Any other
  // refusal (an invalid definition, a permission problem) still fails the job with its reason.
  const error = await failure(created, `creating ${definition.name}`);
  if (!(await labelNames()).has(definition.name)) throw error;
  console.info(`label ${definition.name}: created concurrently`);
}
