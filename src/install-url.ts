import { CliError } from './errors';

/** Never echo a signed URL: its query string is a download credential. */
export function parseInstallUrl(value: unknown): URL {
  let url: URL;
  try {
    if (typeof value !== 'string') throw new Error();
    url = new URL(value);
  } catch { throw new CliError('install: --url must be an absolute HTTP(S) URL', 2); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new CliError('install: URL must use HTTP(S), without credentials or a fragment', 2);
  return url;
}

export function validateInstallSha(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
    throw new CliError('install: sha256 must contain exactly 64 hexadecimal characters', 2);
  return value.toLowerCase();
}
