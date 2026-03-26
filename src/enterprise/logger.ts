// ── Structured Logging with pino ──────────────────────────────────────────

import type { EnterpriseConfig } from './config.js';

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

let pinoModule: any = null;

async function loadPino(): Promise<any> {
  if (!pinoModule) {
    pinoModule = (await import('pino')).default;
  }
  return pinoModule;
}

class PinoLogger implements Logger {
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    data ? this.logger.trace(data, msg) : this.logger.trace(msg);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    data ? this.logger.debug(data, msg) : this.logger.debug(msg);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    data ? this.logger.info(data, msg) : this.logger.info(msg);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    data ? this.logger.warn(data, msg) : this.logger.warn(msg);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    data ? this.logger.error(data, msg) : this.logger.error(msg);
  }
  fatal(msg: string, data?: Record<string, unknown>): void {
    data ? this.logger.fatal(data, msg) : this.logger.fatal(msg);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new PinoLogger(this.logger.child(bindings));
  }
}

class ConsoleLogger implements Logger {
  private context: Record<string, unknown>;
  private level: string;
  private static LEVELS: Record<string, number> = {
    trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
  };

  constructor(level: string = 'info', context: Record<string, unknown> = {}) {
    this.level = level;
    this.context = context;
  }

  private shouldLog(msgLevel: string): boolean {
    return (ConsoleLogger.LEVELS[msgLevel] ?? 30) >= (ConsoleLogger.LEVELS[this.level] ?? 30);
  }

  private log(level: string, msg: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry = {
      level,
      time: new Date().toISOString(),
      msg,
      ...this.context,
      ...data,
    };
    const fn = level === 'error' || level === 'fatal' ? console.error : console.log;
    fn(JSON.stringify(entry));
  }

  trace(msg: string, data?: Record<string, unknown>): void { this.log('trace', msg, data); }
  debug(msg: string, data?: Record<string, unknown>): void { this.log('debug', msg, data); }
  info(msg: string, data?: Record<string, unknown>): void { this.log('info', msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void { this.log('warn', msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.log('error', msg, data); }
  fatal(msg: string, data?: Record<string, unknown>): void { this.log('fatal', msg, data); }
  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.level, { ...this.context, ...bindings });
  }
}

export async function createLogger(config: EnterpriseConfig): Promise<Logger> {
  try {
    const pino = await loadPino();
    const pinoLogger = pino({
      level: config.logging.level,
      ...(config.logging.prettyPrint
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    });
    return new PinoLogger(pinoLogger);
  } catch {
    return new ConsoleLogger(config.logging.level);
  }
}
