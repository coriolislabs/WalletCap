// SPDX-License-Identifier: Apache-2.0
// Checks the rules the workflows must keep, with no YAML library: CI runs it in the lint job.
// Every workflow in .github/workflows:
// - pins every action to a commit SHA, and never keeps the checkout's token;
// - runs on no event that hands a fork's code a token (pull_request_target, workflow_run);
// - grants no write-all, and id-token: write to a job, never to the whole workflow.
// publish.yml:
// - grants contents: read at the top, and id-token: write only to the four publish jobs, which
//   name an environment, check out nothing, build nothing and only publish what a build job
//   packed, by a path npm can't read as a repository (./out/…);
// - resolves the tag to a commit once, and every other checkout is of that commit;
// - packs and uploads each artifact before the job runs a test;
// - skips install scripts in every npm ci and npm install, builds the wheel with a hash-pinned
//   backend, and restores no cache;
// - a run by hand names a tag and runs from it; the PyPI build runs the suite on the locked dev
//   group, as CI does.
import { readdirSync, readFileSync } from 'node:fs';

const failures = [];
const fail = message => failures.push(message);
const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const read = name => readFileSync(new URL(name, WORKFLOWS), 'utf8');

// The jobs of a workflow, by name: the lines under `jobs:` indented two spaces, to the next one.
const jobsOf = text => {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
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

const names = readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name));
for (const expected of ['ci.yml', 'publish.yml', 'mcp-registry.yml']) if (!names.includes(expected)) fail(`${expected}: missing`);
for (const name of names) {
  const text = read(name);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const uses = /^\s*(?:- )?uses:\s*(\S+)/.exec(line);
    if (uses === null) return;
    const [action, ref = ''] = uses[1].split('@');
    if (!/^[0-9a-f]{40}$/.test(ref)) fail(`${name}: ${action} is pinned to ${ref || 'nothing'}, not a commit SHA`);
    if (action === 'actions/checkout') {
      // The step's own lines: to the next step, or to a line indented no deeper than this one.
      const indent = line.search(/\S/);
      const step = [];
      for (const next of lines.slice(index + 1)) {
        if (next.trim() !== '' && next.search(/\S/) <= indent) break;
        step.push(next);
      }
      if (!step.some(next => next.trim() === 'persist-credentials: false')) fail(`${name}: a checkout keeps its token (persist-credentials: false is missing)`);
    }
  });
  if (/^\s*(pull_request_target|workflow_run):/m.test(text)) fail(`${name}: runs on pull_request_target or workflow_run, which hand a fork's code a token`);
  if (/permissions:\s*write-all/.test(text)) fail(`${name}: grants write-all`);
  const top = text.slice(0, text.indexOf('\njobs:'));
  if (/^ {2}id-token:\s*write/m.test(top)) fail(`${name}: grants id-token: write to the whole workflow, not to the job that needs it`);
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
    if (!/^ {4}environment: (npm|pypi)$/m.test(body)) fail(`publish.yml: ${job} is a publish job without the npm or pypi environment`);
    for (const line of body.split('\n')) {
      if (/\bnpm publish\b/.test(line) && !/\bnpm publish \.\/out\//.test(line)) {
        fail(`publish.yml: ${job} runs "${line.trim()}": npm reads a path without ./ as a repository to fetch`);
      }
    }
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
// The lines of `on.workflow_dispatch.inputs.tag`, read by indentation.
const dispatch = publish.split('\n');
const tagAt = dispatch.findIndex(
  (line, index) => line === '      tag:' && dispatch[index - 1] === '    inputs:' && dispatch[index - 2] === '  workflow_dispatch:',
);
const tagInput = [];
for (const line of tagAt < 0 ? [] : dispatch.slice(tagAt + 1)) {
  if (!line.startsWith('        ')) break;
  tagInput.push(line.trim());
}
if (!tagInput.includes('required: true')) fail('publish.yml: a run by hand must name the tag it publishes (inputs.tag, required)');
// The release job resolves the tag once; every other job builds that commit, whatever the tag
// names by then.
const release = jobs.get('release') ?? '';
if (!release.includes('test "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$GITHUB_SHA"'))
  fail("publish.yml: the tag is not checked to be the run's own commit");
if (!release.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')) fail('publish.yml: the tag is not checked to be on main');
for (const [job, body] of jobs) {
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (!/uses:\s*actions\/checkout@/.test(line)) return;
    const ref = lines
      .slice(index + 1, index + 6)
      .find(next => next.trim().startsWith('ref:'))
      ?.trim();
    // GitHub's own expression, built so it doesn't read as one of this file's templates.
    const want = ['ref: $', '{{ ', job === 'release' ? 'github.sha' : 'needs.release.outputs.sha', ' }}'].join('');
    if (ref !== want) fail(`publish.yml: ${job} checks out "${ref ?? 'the default ref'}", not the commit the release job verified (${want})`);
  });
  // A build job's artifact is out of reach before anything it tests runs.
  if (job.startsWith('build-')) {
    const upload = body.lastIndexOf('actions/upload-artifact@');
    const tests = [/\bnpm test\b/, /\bnode --test\b/, /\bpytest\b/].map(pattern => body.search(pattern)).filter(at => at >= 0);
    if (upload < 0) fail(`publish.yml: ${job} uploads no artifact`);
    else if (tests.some(at => at < upload)) fail(`publish.yml: ${job} runs a test before it has uploaded what it packed`);
  }
  if (/astral-sh\/setup-uv@/.test(body) && !(body.includes('enable-cache: false') && /^\s+version: "[0-9.]+"$/m.test(body))) {
    fail(`publish.yml: ${job} sets up uv without a named version and enable-cache: false`);
  }
  for (const line of body.split('\n')) {
    if (/\buv build\b/.test(line) && !(line.includes('--build-constraints') && line.includes('--require-hashes'))) {
      fail(`publish.yml: ${job} runs "${line.trim()}" without the hash-pinned build backend (--build-constraints … --require-hashes)`);
    }
  }
}
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
process.stdout.write(
  `workflows (${names.length}): actions pinned, no kept tokens; publish.yml least-privilege, commit-pinned, packed before tests, scripts off\n`,
);
