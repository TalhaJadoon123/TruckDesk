import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Desktop dev loop: rebuild on change, then relaunch Electron.
 *
 * `electron` is optional. When it is not installed this script says so plainly
 * and exits 0, because the desktop package is not required for the web or API
 * tiers to build, typecheck and test.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

const code = await run('npm', ['exec', '--', 'electron', '--version']);
if (code !== 0) {
  console.log(
    '\n[desktop] electron is not installed in this workspace.\n' +
      '           Install it with:  pnpm --filter @truckdesk/desktop add -D electron\n' +
      '           The API, web and docs tiers do not need it.\n',
  );
  process.exit(0);
}

await run('npm', ['run', 'build']);
await run('npm', ['run', 'build:main']);
await run('npm', ['exec', '--', 'electron', '.']);