import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Provider, ProviderCapabilities, ProviderRunInput, ProviderRunMeta } from '../../core/src/index.ts';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CODEX_BINARY = 'codex';

export interface CodexCliProviderOptions {
  codexBinary?: string;
  workspaceRoot?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: string;
  extraArgs?: string[];
  defaultTimeoutMs?: number;
  commandRunner?: CodexCommandRunner;
}

export interface CodexCliProviderCommand {
  command: string;
  args: string[];
  stdin: string;
}

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export type CodexCommandRunner = (
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number
) => Promise<CommandExecutionResult>;

export class CodexCliProviderError extends Error {
  readonly code: 'TIMEOUT' | 'EXECUTION_FAILED' | 'SPAWN_FAILED';
  readonly meta: ProviderRunMeta;

  constructor(
    message: string,
    code: CodexCliProviderError['code'],
    meta: ProviderRunMeta
  ) {
    super(message);
    this.name = 'CodexCliProviderError';
    this.code = code;
    this.meta = meta;
  }
}

const CODEX_CLI_CAPABILITIES: ProviderCapabilities = {
  systemPromptMode: 'inline',
  supportsPatchOutput: true
};

export class CodexCliProvider implements Provider {
  readonly id = 'codex-cli';
  readonly capabilities = CODEX_CLI_CAPABILITIES;

  private readonly options: CodexCliProviderOptions;
  private readonly commandRunner: CodexCommandRunner;

  constructor(options: CodexCliProviderOptions = {}) {
    this.options = options;
    this.commandRunner = options.commandRunner ?? runCodexCommand;
  }

  async run(input: ProviderRunInput) {
    const timeoutMs = input.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const commandSpec = buildCodexExecCommand(input, this.options);

    let execution: CommandExecutionResult;

    try {
      execution = await this.commandRunner(
        commandSpec.command,
        commandSpec.args,
        commandSpec.stdin,
        timeoutMs
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const meta: ProviderRunMeta = {
        durationMs: 0,
        stdout: '',
        stderr: message,
        command: [commandSpec.command, ...commandSpec.args]
      };
      throw new CodexCliProviderError(
        `codex exec 프로세스를 시작하지 못했습니다: ${message}`,
        'SPAWN_FAILED',
        meta
      );
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
      throw new CodexCliProviderError(
        `codex exec 타임아웃(${timeoutMs}ms)`,
        'TIMEOUT',
        meta
      );
    }

    if (execution.exitCode !== 0) {
      throw new CodexCliProviderError(
        `codex exec 실패(exitCode=${execution.exitCode ?? 'null'})\n${execution.stderr.trim()}`,
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

export function buildCodexExecCommand(
  input: ProviderRunInput,
  options: CodexCliProviderOptions = {}
): CodexCliProviderCommand {
  const command = options.codexBinary ?? DEFAULT_CODEX_BINARY;
  const workspaceRoot = path.resolve(options.workspaceRoot ?? input.workspaceDir);
  const args = ['exec', '--color', 'never', '-C', workspaceRoot];

  if (options.sandboxMode) {
    args.push('--sandbox', options.sandboxMode);
  }

  if (options.approvalPolicy) {
    args.push('-c', `approval_policy=${toTomlString(options.approvalPolicy)}`);
  }

  if (options.extraArgs && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }

  const stdin = createPrompt(input.systemPrompt, input.userPrompt);

  return { command, args, stdin };
}

function createPrompt(systemPrompt: string, userPrompt: string): string {
  const trimmedSystemPrompt = systemPrompt.trim();
  const trimmedUserPrompt = userPrompt.trim();

  return [
    '[SYSTEM]',
    trimmedSystemPrompt,
    '',
    '[USER]',
    trimmedUserPrompt,
    ''
  ].join('\n');
}

function toTomlString(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

async function runCodexCommand(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number
): Promise<CommandExecutionResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
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

    child.stdin.on('error', () => {
      // 타임아웃 시 stdin이 먼저 닫힐 수 있으므로 무시한다.
    });
    child.stdin.end(stdin);
  });
}
