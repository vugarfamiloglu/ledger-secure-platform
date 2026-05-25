/** Express bootstrap shared by every microservice. */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { loadEnvLocal } from './db';

loadEnvLocal();

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m', '\x1b[31m', '\x1b[95m'];
const RESET = '\x1b[0m';
let colorCursor = 0;

export interface BootOptions { name: string; port: number; }
export interface Logger {
  info: (msg: string, ...extra: any[]) => void;
  warn: (msg: string, ...extra: any[]) => void;
  error: (msg: string, ...extra: any[]) => void;
}

export function bootService(opts: BootOptions): { app: Express; log: Logger; port: number } {
  const color = COLORS[colorCursor++ % COLORS.length];
  const log: Logger = {
    info:  (m, ...x) => console.log(`${color}[${opts.name}]${RESET} ${m}`, ...x),
    warn:  (m, ...x) => console.warn(`${color}[${opts.name}]${RESET} ⚠ ${m}`, ...x),
    error: (m, ...x) => console.error(`${color}[${opts.name}]${RESET} ✗ ${m}`, ...x),
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.get('/health', (_req, res) => res.json({ service: opts.name, ok: true, uptime_sec: Math.round(process.uptime()) }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      if (req.path !== '/health') log.info(`${req.method} ${req.path} → ${res.statusCode} ${ms}ms`);
    });
    next();
  });
  process.on('uncaughtException',  (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
  return { app, log, port: opts.port };
}

export function start(app: Express, port: number, name: string, onReady?: () => void): void {
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err?.__http ?? 500;
    if (status >= 500) console.error(`[${name}] unhandled`, err);
    res.status(status).json({ error: err?.message ?? 'Internal error' });
  });
  app.listen(port, () => {
    console.log(`\x1b[32m✓ ${name} listening on http://localhost:${port}\x1b[0m`);
    onReady?.();
  });
}

export function bad(status: number, message: string): never {
  throw Object.assign(new Error(message), { __http: status });
}
