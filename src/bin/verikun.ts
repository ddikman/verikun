#!/usr/bin/env node
import { run } from '../cli';

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write('Fatal: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    process.exit(3);
  },
);
