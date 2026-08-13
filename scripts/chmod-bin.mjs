// Make the built CLI entry points executable.
//
// `tsc` writes plain 0644 files, and nothing else in the build sets the executable bit. That
// is invisible for `npm install -g verikun`, because npm chmods `bin` targets itself while
// unpacking a tarball — but `npm link` symlinks the file in place, so the global `vk` points
// straight at a non-executable file and every invocation dies with:
//
//     zsh: permission denied: vk
//
// which reads like a broken install rather than a missing mode bit. Contributors hit it on a
// fresh clone, and the workaround (`node dist/bin/verikun.js`) hides it again.
//
// Runs as `postbuild`, so it covers `npm run build`, `npm test`'s build step, and the
// `prepare` hook on a plain `npm install`. Plain ESM, zero deps (matches gen-version.mjs).
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Read the targets from `bin` rather than hard-coding them, so adding or renaming an entry
// point cannot silently leave it unexecutable. Both names point at one file today; dedupe so
// the log does not claim to have done the same work twice.
const targets = [...new Set(Object.values(pkg.bin ?? {}))];
if (targets.length === 0) {
  console.error('chmod-bin: package.json has no "bin" entries — nothing to do.');
  process.exit(0);
}

const missing = [];
for (const rel of targets) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    missing.push(rel);
    continue;
  }
  // 0o755, not `+x` on the current mode: the point is to land on a known-good mode
  // regardless of the developer's umask.
  chmodSync(file, 0o755);
}

if (missing.length) {
  // A bin listed but not built means the build did not produce what package.json promises —
  // the published package would install and then have no runnable `vk`.
  console.error(`chmod-bin: FAILED — "bin" names files the build did not produce: ${missing.join(', ')}`);
  process.exit(1);
}

// SILENT ON SUCCESS, deliberately. `npm pack --json` runs the `prepare` hook — which runs
// this — and then expects its own JSON on stdout, so a chatty build step here is parsed as
// part of the pack result and takes down scripts/check-package-contents.mjs (and with it the
// release gate). Same rule the CLI itself follows: stdout is data, diagnostics go to stderr.
