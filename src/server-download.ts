import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseInstallUrl } from './install-url';
import { HttpError } from './server-http';

class DownloadError extends HttpError {
  constructor(message: string, readonly retryable = false) { super(502, message, 3); }
}

interface DownloadOptions {
  cap: number;
  signal: AbortSignal;
  log: (message: string) => void;
  timeoutMs?: number;
  idleMs?: number;
  retryDelayMs?: number;
}

/** Only the artifact URL is sent upstream, never the server's bearer auth or run token. */
async function response(url: URL, signal: AbortSignal, idleMs: number, redirects = 0): Promise<IncomingMessage> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { signal }, resolve);
    req.setTimeout(idleMs, () => req.destroy(new DownloadError('APK download stalled', true)));
    req.on('error', e => reject(e instanceof DownloadError ? e : new DownloadError('APK download connection failed', true)));
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(res.statusCode!)) {
    const location = res.headers.location;
    res.destroy();
    if (!location || redirects >= 5) throw new DownloadError('APK download redirect limit exceeded or location missing');
    let next: URL;
    try { next = parseInstallUrl(new URL(location, url).href); }
    catch { throw new DownloadError('APK download redirected to an invalid URL'); }
    if (url.protocol === 'https:' && next.protocol !== 'https:')
      throw new DownloadError('APK download refused an HTTPS to HTTP redirect');
    return response(next, signal, idleMs, redirects + 1);
  }
  if (res.statusCode !== 200) {
    res.destroy();
    const status = res.statusCode!;
    throw new DownloadError(`APK download returned HTTP ${status}`, status === 408 || status === 429 || status >= 500);
  }
  return res;
}

/** All retries share one deadline; each attempt truncates the partial file. */
export async function downloadApk(url: URL, path: string, opts: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  opts.signal.addEventListener('abort', cancel, { once: true });
  if (opts.signal.aborted) cancel();
  const timer = setTimeout(cancel, opts.timeoutMs ?? 10 * 60_000);
  timer.unref();
  try {
    for (let attempt = 1; ; attempt++) {
      let res: IncomingMessage | undefined;
      try {
        controller.signal.throwIfAborted();
        opts.log(`APK download attempt ${attempt}/3 started`);
        res = await response(url, controller.signal, opts.idleMs ?? 60_000);
        const length = Number(res.headers['content-length']);
        if (length > opts.cap) throw new HttpError(413, `APK download exceeds ${opts.cap} bytes`);
        let bytes = 0;
        let lastProgress = Date.now();
        const hash = createHash('sha256');
        const counter = new Transform({ transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length;
          if (bytes > opts.cap) { cb(new HttpError(413, `APK download exceeds ${opts.cap} bytes`)); return; }
          hash.update(chunk);
          if (Date.now() - lastProgress >= 10_000) {
            opts.log(`APK download received ${bytes} bytes`);
            lastProgress = Date.now();
          }
          cb(null, chunk);
        } });
        await pipeline(res, counter, createWriteStream(path), { signal: controller.signal });
        if (!bytes) throw new DownloadError('APK download was empty');
        opts.log(`APK download complete: ${bytes} bytes`);
        return { bytes, sha256: hash.digest('hex') };
      } catch (e) {
        res?.destroy();
        if (controller.signal.aborted) throw new HttpError(504, 'APK download cancelled or exceeded its deadline', 3);
        if (e instanceof HttpError && (!(e instanceof DownloadError) || !e.retryable)) throw e;
        if (!(e instanceof DownloadError) && !['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ETIMEDOUT', 'EPIPE'].includes((e as NodeJS.ErrnoException).code ?? ''))
          throw new HttpError(500, 'Could not save the downloaded APK', 3);
        if (attempt === 3) throw new DownloadError('APK download failed after 3 attempts');
        opts.log('APK download interrupted; retrying');
        await delay(opts.retryDelayMs ?? attempt * 1000, undefined, { signal: controller.signal }).catch(() => {
          throw new HttpError(504, 'APK download cancelled or exceeded its deadline', 3);
        });
      }
    }
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', cancel);
  }
}
