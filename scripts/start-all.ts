/**
 * Orchestrator — spawns every backend service + the Next.js frontend
 * and tags their output by service name + colour.  Ctrl-C stops them
 * all cleanly.
 *
 *   npm run dev
 *
 * Each service runs in its own child process so a crash in one
 * doesn't take the others down.  The frontend boots last so it can
 * talk to the services through the /api gateway from the first
 * request.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

interface ServiceDef { name: string; cmd: string; args: string[]; color: string; }

const RESET = '\x1b[0m';
const SERVICES: ServiceDef[] = [
  { name: 'ledger',         cmd: 'tsx', args: ['services/ledger/index.ts'],         color: '\x1b[36m' }, // cyan
  { name: 'payments',       cmd: 'tsx', args: ['services/payments/index.ts'],       color: '\x1b[33m' }, // yellow
  { name: 'fx',             cmd: 'tsx', args: ['services/fx/index.ts'],             color: '\x1b[35m' }, // magenta
  { name: 'reconciliation', cmd: 'tsx', args: ['services/reconciliation/index.ts'], color: '\x1b[34m' }, // blue
  { name: 'fraud',          cmd: 'tsx', args: ['services/fraud/index.ts'],          color: '\x1b[31m' }, // red
  { name: 'webhook',        cmd: 'tsx', args: ['services/webhook/index.ts'],        color: '\x1b[32m' }, // green
  { name: 'frontend',       cmd: 'next', args: ['dev', 'frontend', '-p', '5110'],   color: '\x1b[95m' }, // pink
];

const procs: ChildProcess[] = [];

function pipe(name: string, color: string, stream: NodeJS.ReadableStream, isErr: boolean): void {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        const stream = isErr ? process.stderr : process.stdout;
        stream.write(`${color}[${name.padEnd(14)}]${RESET} ${line}\n`);
      }
    }
  });
}

function start(def: ServiceDef): void {
  const child = spawn(def.cmd, def.args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '1' },
    shell: process.platform === 'win32',
  });
  procs.push(child);
  pipe(def.name, def.color, child.stdout!, false);
  pipe(def.name, def.color, child.stderr!, true);
  child.on('exit', (code) => {
    process.stdout.write(`${def.color}[${def.name.padEnd(14)}]${RESET} exited (code ${code})\n`);
  });
}

console.log('\n\x1b[36mLedger Secure Platform\x1b[0m — booting 6 services + frontend');
console.log('---------------------------------------------------------------\n');

SERVICES.forEach((s, i) => setTimeout(() => start(s), i * 350));

const shutdown = () => {
  console.log('\nShutting down…');
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 800);
};
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
