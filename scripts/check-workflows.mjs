// SPDX-License-Identifier: Apache-2.0
// Checks the rules the workflows must keep, with no YAML library: CI runs it in the lint job.
// - Every action is pinned to a commit SHA.
// - publish.yml grants contents: read at the top, and id-token: write only to the four publish
//   jobs, which check out nothing, build nothing and only publish what a build job packed.
// - Every npm ci and npm install in publish.yml skips install scripts.
// - A run by hand names a tag and runs from it; the PyPI build runs the suite on the locked dev
//   group, as CI does.
import { readFileSync } from 'node:fs';

const failures = [];
const fail = message => failures.push(message);
const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

// The jobs of a workflow, by name: the lines under `jobs:` indented two spaces, to the next one.
const jobsOf = text => {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === 'jobs:');
  const jobs = new Map();
  let name = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      name = header[1];
      jobs.set(name, []);
    } else if (name !== null) {
      jobs.get(name).push(line);
    }
  }
  return new Map([...jobs].map(([job, body]) => [job, body.join('\n')]));
};

for (const name of ['ci.yml', 'publish.yml', 'mcp-registry.yml']) {
  for (const [, action, ref] of read(name).matchAll(/uses:\s*([^@\s]+)@(\S+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(ref)) fail(`${name}: ${action} is pinned to ${ref}, not a commit SHA`);
  }
}

const publish = read('publish.yml');
const top = /\npermissions:\n((?: {2}.*\n)+)/.exec(publish);
if (top === null || top[1].trim() !== 'contents: read') fail('publish.yml: the top-level permissions are not exactly contents: read');

const PUBLISHERS = new Set(['pypi', 'npm', 'mcp', 'crash-test']);
const jobs = jobsOf(publish);
for (const [job, body] of jobs) {
  const token = /id-token:\s*write/.test(body);
  if (token && !PUBLISHERS.has(job)) fail(`publish.yml: ${job} gets id-token: write, but only the publish jobs may`);
  if (PUBLISHERS.has(job)) {
    if (!token) fail(`publish.yml: ${job} is a publish job without id-token: write`);
    if (/actions\/checkout|npm ci|npm test|npm run|uv run|uv build/.test(body)) {
      fail(`publish.yml: ${job} checks out, builds or tests; a publish job only publishes what a build job packed`);
    }
  }
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('#') && /\bnpm (ci|install)\b/.test(line) && !line.includes('--ignore-scripts')) {
      fail(`publish.yml: ${job} runs "${line.trim()}" without --ignore-scripts`);
    }
  }
}
for (const job of PUBLISHERS) if (!jobs.has(job)) fail(`publish.yml: no ${job} job`);
if (!/workflow_dispatch:\n\s+inputs:\n\s+tag:\n(?:\s+.*\n)*?\s+required: true/.test(publish)) {
  fail('publish.yml: a run by hand must name the tag it publishes (inputs.tag, required)');
}
if (!/git merge-base --is-ancestor "refs\/tags\/\$TAG" origin\/main/.test(publish)) fail('publish.yml: the tag is not checked to be on main');
// The environments allow only the release tags: a run from a branch must stop before it builds.
if (!/REF: \$\{\{ github\.ref \}\}/.test(publish) || !/if \[ "\$REF" != "refs\/tags\/\$tag" \]; then\n\s+echo [^\n]*\n\s+exit 1/.test(publish)) {
  fail('publish.yml: a run is not checked to be from the tag it publishes (github.ref)');
}
if (!/uv run --locked pytest -q/.test(jobs.get('build-walletcap') ?? '')) {
  fail('publish.yml: the PyPI build does not run the suite on the locked dev group (uv run --locked pytest -q)');
}

if (failures.length > 0) {
  for (const message of failures) process.stderr.write(`${message}\n`);
  process.exit(1);
}
process.stdout.write('workflows: actions pinned; publish.yml least-privilege, tag-checked, scripts off\n');
