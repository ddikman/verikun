import { CliError } from './errors';

// Minimal, dependency-free argv parser supporting:
//   command positional1 positional2 ...
//   --flag value     --flag=value     --flag (boolean)
//   -d value (aliases)                -c (boolean alias)
//   --               everything after is a positional (lets text start with '-')

export type Flags = Record<string, string | boolean>;

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Flags;
}

const ALIASES: Record<string, string> = {
  d: 'device',
  i: 'index',
  o: 'out',
  p: 'platform',
  c: 'contains',
  j: 'json',
  q: 'quiet',
  h: 'help',
  v: 'version',
  t: 'timeout',
};

// Flags that never consume a following value.
const BOOLEAN = new Set([
  'json',
  'contains',
  'all',
  'gone',
  'enter',
  'clear',
  'tree',
  'help',
  'quiet',
  'version',
  'ios',
  'android',
  'fix',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('-') && tok !== '-') {
      let name = tok.replace(/^-+/, '');
      let inlineValue: string | undefined;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = ALIASES[name] ?? name;

      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
      } else if (BOOLEAN.has(name)) {
        flags[name] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !(next.startsWith('-') && next !== '-')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(tok);
    }
  }

  const command = positionals.shift();
  return { command, positionals, flags };
}

export function flagStr(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

export function flagNum(flags: Flags, name: string): number | undefined {
  const v = flagStr(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`--${name} must be a number, got '${v}'`, 2);
  return n;
}
