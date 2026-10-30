import { parentPort, workerData } from 'node:worker_threads';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Own the socket AND the timer: synchronous model repair on the main thread cannot
// starve client-originated heartbeat bytes. Closing the process closes this hold too.
const { url, headers, timeoutMs } = workerData as { url: string; headers: Record<string, string>; timeoutMs: number };
const endpoint = new URL(url);
const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
let leased = false;
let closing = false;
const req = send(endpoint, { method: 'POST', headers }, res => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    data += chunk;
    if (leased || !data.includes('\n')) return;
    if (res.statusCode === 200) {
      try { parentPort?.postMessage({ kind: 'leased', body: JSON.parse(data.split('\n')[0]) }); leased = true; }
      catch { parentPort?.postMessage({ kind: 'error', message: 'invalid lease response' }); req.destroy(); }
    }
  });
  res.on('end', () => {
    if (!leased) {
      let body: unknown;
      try { body = JSON.parse(data); } catch { body = { error: data }; }
      parentPort?.postMessage({ kind: 'status', status: res.statusCode, body });
    } else if (!closing) parentPort?.postMessage({ kind: 'ended' });
    stop();
  });
  res.on('error', e => { if (!closing) parentPort?.postMessage({ kind: 'error', message: e.message }); stop(); });
});
const heartbeat = setInterval(() => { if (!req.destroyed) req.write('.'); }, 10_000);
const timeout = setTimeout(() => {
  if (!leased) req.destroy(new Error('lease acquisition timed out'));
}, timeoutMs);
function stop(): void { clearInterval(heartbeat); clearTimeout(timeout); req.destroy(); parentPort?.close(); }
req.on('error', e => { if (!closing) parentPort?.postMessage({ kind: 'error', message: e.message }); stop(); });
parentPort?.on('message', m => { if (m === 'close') { closing = true; stop(); } });
req.flushHeaders(); req.write('.');
