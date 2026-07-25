import { CopilotClient } from '@github/copilot-sdk';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.argv.includes('--check')) {
  const client = new CopilotClient();
  for (const method of ['start', 'listModels', 'stop']) {
    if (typeof client[method] !== 'function') throw new TypeError(`CopilotClient.${method} is not available`);
  }
  console.log('Copilot SDK auth-doctor contract: OK');
  process.exit(0);
}

const tokenEntries = [
  ['COPILOT_GITHUB_TOKEN', process.env.COPILOT_GITHUB_TOKEN],
  ['GITHUB_COPILOT_TOKEN', process.env.GITHUB_COPILOT_TOKEN],
  ['GITHUB_TOKEN', process.env.GITHUB_TOKEN],
  ['GH_TOKEN', process.env.GH_TOKEN],
].filter(([, value]) => Boolean(value));

console.log('CopilotChat auth doctor');
console.log('Token env vars visible:', tokenEntries.map(([name, value]) => `${name}(${String(value).length} chars)`).join(', ') || 'none');
const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
console.log('gh auth status exit:', gh.status);
console.log((gh.stdout || gh.stderr || '').trim() || '(no gh output)');
const cliPath = resolveCopilotCliPath();
console.log('copilot CLI path:', cliPath ?? 'not found on PATH');
if (cliPath) {
  const version = spawnSync(cliPath, ['--version'], { encoding: 'utf8' });
  console.log('copilot CLI version:', (version.stdout || version.stderr || '').trim() || `exit ${version.status}`);
  const probe = spawnSync(cliPath, ['-p', 'reply OK', '--output-format', 'text', '--stream', 'off', '--silent'], { encoding: 'utf8', timeout: 30000 });
  console.log('copilot CLI prompt exit:', probe.status);
  if (probe.status !== 0) console.log(cleanOutput(probe.stderr || probe.stdout) || '(no copilot prompt output)');
}
const token = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GITHUB_COPILOT_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const client = new CopilotClient(clientOptions(token, cliPath));
try {
  await Promise.race([client.start(), new Promise((_, reject) => setTimeout(() => reject(new Error('start timeout')), 15_000))]);
  const models = await Promise.race([client.listModels(), new Promise((_, reject) => setTimeout(() => reject(new Error('model timeout')), 15_000))]);
  console.log(`Copilot SDK model discovery: OK (${models.length} models)`);
  console.log(models.slice(0, 10).map((model) => `- ${model.id} (${model.name})`).join('\n'));
} catch (error) {
  console.error('Copilot SDK model discovery failed:', error instanceof Error ? error.message : String(error));
  printNextSteps();
  process.exitCode = 1;
} finally {
  await client.stop().catch(() => {});
}

function clientOptions(token, cliPath) {
  if (!token && !cliPath) return undefined;
  const options = {};
  if (cliPath) options.cliPath = cliPath;
  if (token) {
    options.gitHubToken = token;
    options.useLoggedInUser = false;
  }
  return options;
}

function resolveCopilotCliPath() {
  const explicit = process.env.COPILOTCHAT_COPILOT_CLI_PATH ?? process.env.COPILOT_CLI_PATH;
  if (explicit) return explicit;
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = os.platform() === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const entry of paths) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `copilot${extension.toLowerCase()}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return undefined;
}

function cleanOutput(output) {
  return output.trim().split('\n').slice(0, 12).join('\n');
}

function printNextSteps() {
  console.error('\nNo usable Copilot auth was found in this shell.');
  console.error('Run one of these, then restart `pnpm dev`:');
  console.error('  copilot login');
  console.error('  gh auth login');
  console.error('  export COPILOT_GITHUB_TOKEN=github_pat_...');
}
