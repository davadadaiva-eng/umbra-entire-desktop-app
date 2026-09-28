import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';

let logger: pino.Logger;
let stdioGuardInstalled = false;

/**
 * Swallow EPIPE / closed-stdout errors (Node 24 crashes the process on an
 * unhandled stdout 'error' when the pipe closes — e.g. log tail exits —
 * which previously filled backend-err.log with EPIPE stack traces).
 * Idempotent: safe to call on every logger init.
 */
function installStdioEpipeGuard(): void {
  if (stdioGuardInstalled) return;
  stdioGuardInstalled = true;
  const swallow = (err: unknown): void => {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPIPE: reader went away. ERR_STREAM_WRITE_AFTER_END: write after destroy.
    if (code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') return;
    // Any other stdio error while logging must not take down the backend.
  };
  try {
    process.stdout.on('error', swallow);
  } catch {}
  try {
    process.stderr.on('error', swallow);
  } catch {}
}

export function initializeLogger(logDir: string, level: string = 'info', prettyPrint: boolean = true): pino.Logger {
  installStdioEpipeGuard();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const transport = prettyPrint
    ? pino.transport({
        targets: [
          {
            target: 'pino/file',
            options: { destination: path.join(logDir, 'umbra.log') },
          },
          {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        ],
      })
    : pino.transport({
        target: 'pino/file',
        options: { destination: path.join(logDir, 'umbra.log') },
      });

  // A closed stdout (EPIPE) surfaces here as a transport 'error' — swallow it
  // so the backend keeps running instead of crashing into backend-err.log.
  try {
    (transport as unknown as NodeJS.EventEmitter).on('error', (err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') return;
    });
  } catch {}

  logger = pino(
    { level, timestamp: pino.stdTimeFunctions.isoTime },
    transport
  );

  return logger;
}

export function getLogger(): pino.Logger {
  installStdioEpipeGuard();
  if (!logger) {
    logger = pino({ level: 'info' });
  }
  return logger;
}
