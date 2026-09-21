import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';

let logger: pino.Logger;

export function initializeLogger(logDir: string, level: string = 'info', prettyPrint: boolean = true): pino.Logger {
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

  logger = pino(
    { level, timestamp: pino.stdTimeFunctions.isoTime },
    transport
  );

  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({ level: 'info' });
  }
  return logger;
}
