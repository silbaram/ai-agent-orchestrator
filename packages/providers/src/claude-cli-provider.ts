import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Provider, ProviderCapabilities, ProviderRunInput, ProviderRunMeta } from '../../core/src/index.ts';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CLAUDE_BINARY = 'claude-cli';

export interface ClaudeCliProviderOptions {
  claudeBinary?: string;
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
  extraArgs?: string[];
  commandRunner?: ClaudeCommandRunner;
}

export interface ClaudeCliProviderCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export type ClaudeCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string
) => Promise<CommandExecutionResult>;

export class ClaudeCliProviderError extends Error {
  readonly code: 'TIMEOUT' | 'EXECUTION_FAILED' | 'SPAWN_FAILED';
  readonly meta: ProviderRunMeta;

  constructor(
    message: string,
    code: ClaudeCliProviderError['code'],
    meta: ProviderRunMeta
  ) {
    super(message);
    this.name = 'ClaudeCliProviderError';
    this.code = code;
    this.meta = meta;
  }
}

const CLAUDE_CLI_CAPABILITIES: ProviderCapabilities = {
  systemPromptMode: 'inline',
  supportsPatchOutput: true
};

export class ClaudeCliProvider implements Provider {
  readonly id = 'claude-cli';
  readonly capabilities = CLAUDE_CLI_CAPABILITIES;

  private readonly options: ClaudeCliProviderOptions;
  private readonly commandRunner: ClaudeCommandRunner;

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.options = options;
    this.commandRunner = options.commandRunner ?? runClaudeCommand;
  }

  async run(input: ProviderRunInput) {
    const timeoutMs = input.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const commandSpec = buildClaudeExecCommand(input, this.options);

    let execution: CommandExecutionResult;

    try {
      execution = await this.commandRunner(
        commandSpec.command,
        commandSpec.args,
        timeoutMs,
        commandSpec.cwd
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const meta: ProviderRunMeta = {
        durationMs: 0,
        stdout: '',
        stderr: message,
        command: [commandSpec.command, ...commandSpec.args]
      };
      throw new ClaudeCliProviderError(`claude-cli 실행을 시작하지 못했습니다: ${message}`, 'SPAWN_FAILED', meta);
    }

    const meta: ProviderRunMeta = {
      durationMs: execution.durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      command: [commandSpec.command, ...commandSpec.args],
      exitCode: execution.exitCode,
      timedOut: execution.timedOut
    };

    if (execution.timedOut) {
      throw new ClaudeCliProviderError(`claude-cli 타임아웃(${timeoutMs}ms)`, 'TIMEOUT', meta);
    }

    if (execution.exitCode !== 0) {
      throw new ClaudeCliProviderError(
        `claude-cli 실패(exitCode=${execution.exitCode ?? 'null'})\n${execution.stderr.trim()}`,
        'EXECUTION_FAILED',
        meta
      );
    }

    return {
      text: execution.stdout.trimEnd(),
      meta
    };
  }
}

export function buildClaudeExecCommand(
  input: ProviderRunInput,
  options: ClaudeCliProviderOptions = {}
): ClaudeCliProviderCommand {
  const command = options.claudeBinary ?? DEFAULT_CLAUDE_BINARY;
  const cwd = path.resolve(options.workspaceRoot ?? input.workspaceDir);
  const prompt = mergeSystemAndUserPrompt(input.systemPrompt, input.userPrompt);
  const args = ['-p', prompt];

  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  return { command, args, cwd };
}

function mergeSystemAndUserPrompt(systemPrompt: string, userPrompt: string): string {
  const merged = [`[SYSTEM]\n${systemPrompt.trim()}`, `[USER]\n${userPrompt.trim()}`].join('\n\n');

  return merged.trim();
}

async function runClaudeCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string
): Promise<CommandExecutionResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: 'pipe',
      shell: false
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
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
      }, 500);
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut
      });
    });
  });
}
