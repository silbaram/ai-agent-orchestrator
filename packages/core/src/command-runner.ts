import { spawn } from 'node:child_process';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import type { AllowedToolCommand, ToolsConfig } from './tools-config.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 500;
const DEFAULT_LOG_FILE = path.join('logs', 'tool-runtime.log');

export interface CommandRunnerOptions {
  workspaceDir: string;
  runDir: string;
  tools: ToolsConfig;
  defaultTimeoutMs?: number;
  logRelativePath?: string;
}

export interface CommandRunnerRunInput {
  commandId: string;
  timeoutMs?: number;
  stdin?: string;
}

export interface CommandExecutionResult {
  commandId: string;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export class CommandRunnerError extends Error {
  readonly code: 'NOT_ALLOWED' | 'SPAWN_FAILED';
  readonly commandId: string;

  constructor(message: string, code: CommandRunnerError['code'], commandId: string) {
    super(message);
    this.name = 'CommandRunnerError';
    this.code = code;
    this.commandId = commandId;
  }
}

export class CommandRunner {
  private readonly workspaceDir: string;
  private readonly commandMap: Map<string, AllowedToolCommand>;
  private readonly defaultTimeoutMs: number;
  private readonly logFilePath: string;

  constructor(options: CommandRunnerOptions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logFilePath = path.resolve(options.runDir, options.logRelativePath ?? DEFAULT_LOG_FILE);
    this.commandMap = new Map(
      options.tools.commands.map((command) => [normalizeCommandId(command.id), command])
    );
  }

  async run(input: CommandRunnerRunInput): Promise<CommandExecutionResult> {
    const commandId = normalizeCommandId(input.commandId);
    const command = this.commandMap.get(commandId);

    if (!command) {
      const error = new CommandRunnerError(
        `allowlist에 없는 커맨드입니다: ${commandId}`,
        'NOT_ALLOWED',
        commandId
      );
      await this.logExecution({
        event: 'rejected',
        commandId,
        reason: error.message
      });
      throw error;
    }

    const timeoutMs = input.timeoutMs ?? command.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let result: CommandExecutionResult;

    try {
      result = await new Promise<CommandExecutionResult>((resolve, reject) => {
        const child = spawn(command.executable, command.args, {
          cwd: this.workspaceDir,
          stdio: 'pipe',
          shell: false
        });

        let settled = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');

          setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, KILL_GRACE_MS);
        }, timeoutMs);

        child.on('error', (error) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);

          reject(
            new CommandRunnerError(
              `커맨드 시작 실패(${commandId}): ${error.message}`,
              'SPAWN_FAILED',
              commandId
            )
          );
        });

        child.on('close', (exitCode) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);

          resolve({
            commandId,
            command: [command.executable, ...command.args],
            stdout,
            stderr,
            exitCode,
            durationMs: Date.now() - start,
            timedOut
          });
        });

        if (input.stdin !== undefined) {
          child.stdin.setDefaultEncoding('utf8');
          child.stdin.on('error', () => {
            // 타임아웃으로 stdin이 닫힌 경우를 무시한다.
          });
          child.stdin.end(input.stdin);
        } else {
          child.stdin.end();
        }
      });
    } catch (error) {
      if (error instanceof CommandRunnerError) {
        await this.logExecution({
          event: 'spawn_failed',
          commandId,
          reason: error.message
        });
        throw error;
      }

      const fallbackError = new CommandRunnerError(
        `커맨드 시작 실패(${commandId}): ${toErrorMessage(error)}`,
        'SPAWN_FAILED',
        commandId
      );
      await this.logExecution({
        event: 'spawn_failed',
        commandId,
        reason: fallbackError.message
      });
      throw fallbackError;
    }

    await this.logExecution({
      event: 'completed',
      commandId,
      command: result.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: truncateText(result.stdout),
      stderr: truncateText(result.stderr)
    });

    return result;
  }

  private async logExecution(payload: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`;
    await mkdir(path.dirname(this.logFilePath), { recursive: true });
    await appendFile(this.logFilePath, line, 'utf8');
  }
}

function normalizeCommandId(value: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error('commandId는 비어 있을 수 없습니다.');
  }

  return normalized;
}

function truncateText(value: string, limit = 4_000): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
