// One-shot socket client, run as its own process.
//
// It exists because `Driver` is entirely synchronous — every device call is a spawnSync —
// and Node has no synchronous socket. Rather than make getElements() async and ripple that
// through cli.ts, run.ts and the engine, the companion is reached the same way every other
// device call is: by spawning something and reading its stdout.
//
// Measured on a physical SM-A415F: 39ms per round trip including this process's own
// startup, against 2400ms for `uiautomator dump`. The process spawn is most of that 39ms
// and is the price of staying synchronous — worth it at ~60x.
//
// Usage: node sock-client.js <port> <command...>   → reply on stdout, exit 3 if unreachable.

import { connect } from 'node:net';

const [portArg, ...command] = process.argv.slice(2);
const chunks: Buffer[] = [];
const sock = connect(Number(portArg), '127.0.0.1');

sock.on('connect', () => sock.write(command.join(' ') + '\n'));
sock.on('data', (c: Buffer) => chunks.push(c));
sock.on('end', () => process.stdout.write(Buffer.concat(chunks)));
sock.on('error', () => process.exit(3));
