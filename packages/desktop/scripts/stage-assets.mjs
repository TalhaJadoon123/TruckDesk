import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static asset pipeline for the desktop renderer.
 *
 * The renderer is deliberately dependency-free at runtime, so this copies the
 * hand-written HTML, CSS and the compiled JS into `dist/` with no bundler.
 *
 * It never clears `dist/`: that directory is shared with the compiled main
 * process, and emptying it here would delete `main.cjs` and `preload.cjs`
 * depending on which script ran last.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const ui = join(root, 'src', 'ui');
const out = join(root, 'dist');

mkdirSync(out, { recursive: true });

let copied = 0;

function copy(from, to, required) {
  if (!existsSync(from)) {
    if (required) {
      console.error(`[desktop] required asset missing: ${from}`);
      process.exitCode = 1;
    }
    return;
  }
  copyFileSync(from, to);
  copied += 1;
}

copy(join(ui, 'index.html'), join(out, 'index.html'), true);
copy(join(ui, 'app.css'), join(out, 'app.css'), true);
copy(join(root, 'dist-ui', 'app.js'), join(out, 'app.js'), true);

console.log(`[desktop] staged ${copied} asset(s) in ${out}`);