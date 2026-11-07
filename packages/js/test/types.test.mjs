// SPDX-License-Identifier: Apache-2.0
// TypeScript users get what the README shows. Its snippets compile against the packages they
// name, AgentKit's real types included, and the packed package's declarations need nothing but
// themselves.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const JS = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TYPES = join(JS, 'test', 'types');
const require = createRequire(import.meta.url);
const TSC = require.resolve('typescript/bin/tsc');
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-types-'));
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const tsc = (cwd, ...args) => spawnSync(process.execPath, [TSC, '--noEmit', '--strict', '--target', 'es2022', ...args], { cwd, encoding: 'utf8' });
const NODENEXT = ['--module', 'nodenext', '--moduleResolution', 'nodenext'];
const BUNDLER = ['--module', 'esnext', '--moduleResolution', 'bundler'];
const compiles = (result, what) => assert.equal(result.status, 0, `${what}:\n${result.stdout}${result.stderr}`);
// A folder or package linked into a scratch project: a junction on Windows, which needs no rights.
const link = (target, path) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'junction');
};
const project = name => {
  const dir = join(DIR, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  return dir;
};
// The folder of package `name` as Node would find it from `from`, or null.
const findPackage = (from, name) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
};
const version = (from, name) => JSON.parse(read(join(findPackage(from, name), 'package.json'))).version;

const SNIPPETS = readdirSync(TYPES)
  .filter(name => /^readme-.*\.ts$/.test(name))
  .sort();
const WITHOUT_AGENTKIT = SNIPPETS.filter(name => name !== 'readme-agentkit.ts').map(name => `test/types/${name}`);
// The CDP snippet compiles with bundler resolution only: cdp-sdk's types, below.
const NODE_RESOLUTION = WITHOUT_AGENTKIT.filter(name => name !== 'test/types/readme-cdp.ts');
const NODE16 = ['--module', 'node16', '--moduleResolution', 'node16'];

test('every JavaScript snippet in the README is a test/types/readme-*.ts file, word for word', () => {
  const blocks = [...read(join(ROOT, 'README.md')).matchAll(/^```js\n([\s\S]*?)^```/gm)].map(match => match[1]);
  const files = SNIPPETS.map(name => read(join(TYPES, name)));
  for (const block of blocks) {
    assert.ok(
      files.some(text => text.includes(`// --- README ---\n${block}// --- end ---\n`)),
      `no test/types/readme-*.ts holds this README snippet:\n${block}`,
    );
  }
  assert.equal(blocks.length, SNIPPETS.length, 'a test/types/readme-*.ts file holds a snippet the README no longer has');
});

test("the README's snippets compile against the packages they name, with nodenext and with bundler resolution", () => {
  compiles(tsc(JS, '--skipLibCheck', ...NODENEXT, ...NODE_RESOLUTION), 'nodenext');
  compiles(tsc(JS, '--skipLibCheck', ...BUNDLER, ...WITHOUT_AGENTKIT), 'bundler');
});

test("the README's CDP snippet, with a real x402Client, meets cdp-sdk's CommonJS types under node16 and nodenext, and the README's cast compiles", () => {
  for (const [name, resolution] of [
    ['node16', NODE16],
    ['nodenext', NODENEXT],
  ]) {
    const result = tsc(JS, '--skipLibCheck', ...resolution, 'test/types/readme-cdp.ts');
    const errors = result.stdout.split('\n').filter(line => /error TS\d+/.test(line));
    // Once cdp-sdk's types read as ESM there, this compiles: drop the README's note and the cast.
    assert.equal(errors.length, 1, `${name}: expected cdp-sdk's one TS2345:\n${result.stdout}${result.stderr}`);
    assert.match(errors[0], /readme-cdp\.ts\(\d+,\d+\): error TS2345: .*\/esm\/x402Client.*\/cjs\/x402Client/);
    compiles(tsc(JS, '--skipLibCheck', ...resolution, 'test/types/cdp-nodenext.ts'), `${name}, with the README's cast`);
  }
});

test("guard() takes @x402/core's own client and returns its type, from packages/js's x402 and the workspace's newer one", () => {
  compiles(tsc(JS, '--skipLibCheck', ...NODENEXT, 'test/types/x402-client.ts'), `@x402/core ${version(JS, '@x402/core')}`);
  const dir = project('x402-newer');
  link(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  cpSync(join(TYPES, 'x402-client.ts'), join(dir, 'src', 'x402-client.ts'));
  compiles(tsc(dir, '--skipLibCheck', ...NODENEXT, 'src/x402-client.ts'), `@x402/core ${version(ROOT, '@x402/core')}`);
});

// AgentKit 0.10.4 brings about 36 packages, so it is no devDependency: CI's AgentKit types job
// installs it and names the folder in WALLETCAP_AGENTKIT_DIR, and a checkout that has it
// installed uses that.
const agentkit = findPackage(process.env.WALLETCAP_AGENTKIT_DIR ?? JS, '@coinbase/agentkit');
const agentkitSkip =
  agentkit === null && process.env.WALLETCAP_REQUIRE_AGENTKIT !== '1' && 'AgentKit is not installed: set WALLETCAP_AGENTKIT_DIR to a folder where it is';

test("the README's AgentKit recipe compiles against AgentKit's own types; the 0.2.2 subclass doesn't", { skip: agentkitSkip }, () => {
  assert.notEqual(agentkit, null, 'WALLETCAP_REQUIRE_AGENTKIT is set, and AgentKit is not installed');
  const dir = project('agentkit');
  link(agentkit, join(dir, 'node_modules', '@coinbase', 'agentkit'));
  link(JS, join(dir, 'node_modules', 'walletcap'));
  link(join(ROOT, 'node_modules', '@types'), join(dir, 'node_modules', '@types'));
  for (const name of ['readme-agentkit.ts', 'subclass.ts']) cpSync(join(TYPES, name), join(dir, 'src', name));
  const used = JSON.parse(read(join(agentkit, 'package.json'))).version;
  compiles(tsc(dir, '--skipLibCheck', ...NODENEXT, 'src/readme-agentkit.ts'), `@coinbase/agentkit ${used}`);
  const subclass = tsc(dir, '--skipLibCheck', ...NODENEXT, 'src/subclass.ts');
  assert.notEqual(subclass.status, 0);
  assert.match(subclass.stdout, /TS2415/);
});

test("the packed package's declarations stand on their own: no skipLibCheck, es2022's library, no @types/node", () => {
  const npm = process.env.npm_execpath;
  const listed = spawnSync(npm ? process.execPath : 'npm', [...(npm ? [npm] : []), 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: JS,
    encoding: 'utf8',
    shell: !npm && process.platform === 'win32',
  });
  assert.equal(listed.status, 0, listed.stderr);
  const [{ files }] = JSON.parse(listed.stdout);
  const dir = project('consumer');
  const installed = join(dir, 'node_modules', 'walletcap');
  for (const { path } of files) cpSync(join(JS, path), join(installed, path), { recursive: true });
  cpSync(join(TYPES, 'consumer.ts'), join(dir, 'src', 'consumer.ts'));
  const options = { strict: true, noEmit: true, skipLibCheck: false, lib: ['es2022'], types: [], target: 'es2022' };
  for (const [name, resolution] of [
    ['nodenext', { module: 'nodenext', moduleResolution: 'nodenext' }],
    ['bundler', { module: 'esnext', moduleResolution: 'bundler' }],
  ]) {
    writeFileSync(join(dir, `tsconfig.${name}.json`), JSON.stringify({ compilerOptions: { ...options, ...resolution }, files: ['src/consumer.ts'] }));
    const result = spawnSync(process.execPath, [TSC, '-p', `tsconfig.${name}.json`], { cwd: dir, encoding: 'utf8' });
    compiles(result, `moduleResolution ${name}`);
  }
});
