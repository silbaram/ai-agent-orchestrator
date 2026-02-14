import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type RunLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface RunLoggerOptions {
  runDir: string;
  logsDirName?: string;
}

export interface RunLogTarget {
  source: string;
  phase?: string;
}

export interface RunLogEntry {
  message: string;
  level?: RunLogLevel;
  timestamp?: string;
  context?: Record<string, unknown>;
}

export class RunLogger {
  readonly logsDir: string;

  constructor(options: RunLoggerOptions) {
    this.logsDir = path.resolve(options.runDir, options.logsDirName ?? 'logs');
  }

  resolveLogPath(target: RunLogTarget): string {
    const source = normalizeSegment(target.source, 'source');
    const phase = target.phase ? normalizeSegment(target.phase, 'phase') : null;
    const fileName = phase ? `${source}-${phase}.log` : `${source}.log`;

    return path.join(this.logsDir, fileName);
  }

  async append(target: RunLogTarget, entry: RunLogEntry | string): Promise<void> {
    const normalized: RunLogEntry =
      typeof entry === 'string'
        ? {
            message: entry
          }
        : entry;

    const line = formatLogLine(normalized);
    const filePath = this.resolveLogPath(target);

    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, line, 'utf8');
  }

  async read(target: RunLogTarget): Promise<string> {
    return readFile(this.resolveLogPath(target), 'utf8');
  }
}

function formatLogLine(entry: RunLogEntry): string {
  const timestamp = entry.timestamp ?? new Date().toISOString();
  const level = entry.level ?? 'INFO';

  let line = `[${timestamp}] [${level}] ${entry.message}`;
  if (entry.context && Object.keys(entry.context).length > 0) {
    line += ` ${JSON.stringify(entry.context)}`;
  }

  return `${line}\n`;
}

function normalizeSegment(value: string, label: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, '-');

  if (!normalized) {
    throw new Error(`${label}는 비어 있을 수 없습니다.`);
  }

  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new Error(`${label}에 경로 구분자를 포함할 수 없습니다: ${value}`);
  }

  return normalized;
}
