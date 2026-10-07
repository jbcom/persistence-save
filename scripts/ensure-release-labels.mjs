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

const existing = new Set();
for (let page = 1; ; page += 1) {
  const response = await fetch(`${api}/labels?limit=50&page=${page}`, { headers });
  if (!response.ok) throw new Error(`label inventory page ${page} returned ${response.status}`);
  const labels = await response.json();
  for (const label of labels) existing.add(label.name);
  if (labels.length < 50) break;
}

for (const definition of definitions) {
  if (existing.has(definition.name)) continue;
  const created = await fetch(`${api}/labels`, {
    method: 'POST',
    headers,
    body: JSON.stringify(definition),
  });
  // 409/422: another run created it between the inventory and this write.
  if (!created.ok && created.status !== 409 && created.status !== 422) {
    throw new Error(`creating ${definition.name} returned ${created.status}`);
  }
  console.info(`label ${definition.name}: ${created.ok ? 'created' : 'already present'}`);
}
