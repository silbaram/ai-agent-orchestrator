import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Provider, ProviderCapabilities, ProviderRunInput, ProviderRunMeta } from '../../core/src/index.ts';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GEMINI_BINARY = 'gemini';

export interface GeminiCliProviderOptions {
  geminiBinary?: string;
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
  extraArgs?: string[];
  commandRunner?: GeminiCommandRunner;
}

export interface GeminiCliProviderCommand {
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

export type GeminiCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string
) => Promise<CommandExecutionResult>;

export class GeminiCliProviderError extends Error {
  readonly code: 'TIMEOUT' | 'EXECUTION_FAILED' | 'SPAWN_FAILED';
  readonly meta: ProviderRunMeta;

  constructor(
    message: string,
    code: GeminiCliProviderError['code'],
    meta: ProviderRunMeta
  ) {
    super(message);
    this.name = 'GeminiCliProviderError';
    this.code = code;
    this.meta = meta;
  }
}

const GEMINI_CLI_CAPABILITIES: ProviderCapabilities = {
  systemPromptMode: 'inline',
  supportsPatchOutput: true
};

export class GeminiCliProvider implements Provider {
  readonly id = 'gemini-cli';
  readonly capabilities = GEMINI_CLI_CAPABILITIES;

  private readonly options: GeminiCliProviderOptions;
  private readonly commandRunner: GeminiCommandRunner;

  constructor(options: GeminiCliProviderOptions = {}) {
    this.options = options;
    this.commandRunner = options.commandRunner ?? runGeminiCommand;
  }

  async run(input: ProviderRunInput) {
    const timeoutMs = input.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const commandSpec = buildGeminiExecCommand(input, this.options);

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
      throw new GeminiCliProviderError(`gemini-cli 실행을 시작하지 못했습니다: ${message}`, 'SPAWN_FAILED', meta);
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
      throw new GeminiCliProviderError(`gemini-cli 타임아웃(${timeoutMs}ms)`, 'TIMEOUT', meta);
    }

    if (execution.exitCode !== 0) {
      throw new GeminiCliProviderError(
        `gemini-cli 실패(exitCode=${execution.exitCode ?? 'null'})\n${execution.stderr.trim()}`,
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

export function buildGeminiExecCommand(
  input: ProviderRunInput,
  options: GeminiCliProviderOptions = {}
): GeminiCliProviderCommand {
  const command = options.geminiBinary ?? DEFAULT_GEMINI_BINARY;
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

async function runGeminiCommand(
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
