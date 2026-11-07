// SPDX-License-Identifier: Apache-2.0
// Run agent processes: one after another (a restart) or all at once (replicas racing).
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export function run(script, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HERE, script), JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${script} exited ${code}: ${stderr}`))));
  });
}

export async function race(script, dir, configs) {
  const go = join(dir, 'go');
  const runs = configs.map((config, index) => run(script, { ...config, ready: join(dir, `ready-${index}`), go }));
  const until = Date.now() + 60_000;
  while (!configs.every((_, index) => existsSync(join(dir, `ready-${index}`)))) {
    if (Date.now() > until) throw new Error('the processes did not start');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  writeFileSync(go, '');
  const results = await Promise.all(runs);
  unlinkSync(go);
  for (const [index] of configs.entries()) unlinkSync(join(dir, `ready-${index}`));
  return results;
}
