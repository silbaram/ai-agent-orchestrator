import type { CommandExecutionResult, CommandRunner } from './command-runner.ts';

const DEFAULT_DIFF_NAME_STATUS_COMMAND_ID = 'git-diff-name-status';
const DEFAULT_DIFF_NUMSTAT_COMMAND_ID = 'git-diff-numstat';
const DEFAULT_LARGE_CHANGE_FILES = 20;
const DEFAULT_LARGE_CHANGE_LINES = 500;
const DEFAULT_SECURITY_PATH_PATTERN =
  /(^|\/)(auth|security|secrets?|credentials?|tokens?|permissions?)(\/|$)|\.env/i;

export interface GatekeeperOptions {
  commandRunner: Pick<CommandRunner, 'run'>;
  diffNameStatusCommandId?: string;
  diffNumstatCommandId?: string;
  largeChangeFileThreshold?: number;
  largeChangeLineThreshold?: number;
  securityPathPattern?: RegExp;
}

export interface ChangeRiskDecision {
  requiresApproval: boolean;
  reasons: string[];
  deletedFiles: string[];
  securitySensitiveFiles: string[];
  changedFileCount: number;
  totalChangedLines: number;
}

export interface GatekeeperCheckDecision {
  action: 'pass' | 'auto_fix' | 'fail';
  failedCommandIds: string[];
  message: string;
}

export class Gatekeeper {
  private readonly commandRunner: Pick<CommandRunner, 'run'>;
  private readonly diffNameStatusCommandId: string;
  private readonly diffNumstatCommandId: string;
  private readonly largeChangeFileThreshold: number;
  private readonly largeChangeLineThreshold: number;
  private readonly securityPathPattern: RegExp;

  constructor(options: GatekeeperOptions) {
    this.commandRunner = options.commandRunner;
    this.diffNameStatusCommandId =
      options.diffNameStatusCommandId ?? DEFAULT_DIFF_NAME_STATUS_COMMAND_ID;
    this.diffNumstatCommandId = options.diffNumstatCommandId ?? DEFAULT_DIFF_NUMSTAT_COMMAND_ID;
    this.largeChangeFileThreshold = options.largeChangeFileThreshold ?? DEFAULT_LARGE_CHANGE_FILES;
    this.largeChangeLineThreshold = options.largeChangeLineThreshold ?? DEFAULT_LARGE_CHANGE_LINES;
    this.securityPathPattern = options.securityPathPattern ?? DEFAULT_SECURITY_PATH_PATTERN;
  }

  async inspectChanges(): Promise<ChangeRiskDecision> {
    const [nameStatusResult, numstatResult] = await Promise.all([
      this.commandRunner.run({ commandId: this.diffNameStatusCommandId }),
      this.commandRunner.run({ commandId: this.diffNumstatCommandId })
    ]);

    return evaluateRiskFromDiffOutputs({
      nameStatusOutput: nameStatusResult.stdout,
      numstatOutput: numstatResult.stdout,
      nameStatusResult,
      numstatResult,
      largeChangeFileThreshold: this.largeChangeFileThreshold,
      largeChangeLineThreshold: this.largeChangeLineThreshold,
      securityPathPattern: this.securityPathPattern
    });
  }

  async runChecks(commandIds: string[]): Promise<CommandExecutionResult[]> {
    const results: CommandExecutionResult[] = [];

    for (const commandId of commandIds) {
      results.push(await this.commandRunner.run({ commandId }));
    }

    return results;
  }

  decideCheckFailure(input: {
    checkResults: CommandExecutionResult[];
    retryCount: number;
    maxAutoFixRetries: number;
  }): GatekeeperCheckDecision {
    return decideCheckFailure(input);
  }
}

interface EvaluateRiskInput {
  nameStatusOutput: string;
  numstatOutput: string;
  nameStatusResult?: CommandExecutionResult;
  numstatResult?: CommandExecutionResult;
  largeChangeFileThreshold?: number;
  largeChangeLineThreshold?: number;
  securityPathPattern?: RegExp;
}

export function evaluateRiskFromDiffOutputs(input: EvaluateRiskInput): ChangeRiskDecision {
  const reasons: string[] = [];

  if (isFailedResult(input.nameStatusResult)) {
    reasons.push(
      `변경 분석 명령 실패: ${input.nameStatusResult?.commandId} (exitCode=${input.nameStatusResult?.exitCode ?? 'null'})`
    );
  }

  if (isFailedResult(input.numstatResult)) {
    reasons.push(
      `변경 분석 명령 실패: ${input.numstatResult?.commandId} (exitCode=${input.numstatResult?.exitCode ?? 'null'})`
    );
  }

  const nameStatusEntries = parseNameStatusOutput(input.nameStatusOutput);
  const numstatEntries = parseNumstatOutput(input.numstatOutput);

  const deletedFiles = nameStatusEntries.filter((entry) => entry.status === 'D').map((entry) => entry.path);
  if (deletedFiles.length > 0) {
    reasons.push(`파일 삭제 감지(${deletedFiles.length}건)`);
  }

  const changedPaths = new Set<string>();
  for (const entry of nameStatusEntries) {
    changedPaths.add(entry.path);
  }
  for (const entry of numstatEntries) {
    changedPaths.add(entry.path);
  }

  const securityPathPattern = input.securityPathPattern ?? DEFAULT_SECURITY_PATH_PATTERN;
  const securitySensitiveFiles = [...changedPaths].filter((filePath) => securityPathPattern.test(filePath));
  if (securitySensitiveFiles.length > 0) {
    reasons.push(`보안 민감 경로 변경 감지(${securitySensitiveFiles.length}건)`);
  }

  const changedFileCount = changedPaths.size;
  const totalChangedLines = numstatEntries.reduce((sum, entry) => sum + entry.added + entry.deleted, 0);

  const largeChangeFileThreshold = input.largeChangeFileThreshold ?? DEFAULT_LARGE_CHANGE_FILES;
  const largeChangeLineThreshold = input.largeChangeLineThreshold ?? DEFAULT_LARGE_CHANGE_LINES;

  if (changedFileCount >= largeChangeFileThreshold) {
    reasons.push(`대규모 변경 감지: 변경 파일 수 ${changedFileCount}건`);
  }

  if (totalChangedLines >= largeChangeLineThreshold) {
    reasons.push(`대규모 변경 감지: 변경 라인 수 ${totalChangedLines}줄`);
  }

  return {
    requiresApproval: reasons.length > 0,
    reasons,
    deletedFiles,
    securitySensitiveFiles,
    changedFileCount,
    totalChangedLines
  };
}

export function decideCheckFailure(input: {
  checkResults: CommandExecutionResult[];
  retryCount: number;
  maxAutoFixRetries: number;
}): GatekeeperCheckDecision {
  const failed = input.checkResults.filter(isFailedResult);

  if (failed.length === 0) {
    return {
      action: 'pass',
      failedCommandIds: [],
      message: '검증 커맨드가 모두 성공했습니다.'
    };
  }

  const failedCommandIds = failed.map((result) => result.commandId);
  const retriesLeft = input.maxAutoFixRetries - input.retryCount;

  if (retriesLeft > 0) {
    return {
      action: 'auto_fix',
      failedCommandIds,
      message: `검증 실패(${failedCommandIds.join(', ')})로 auto-fix를 시도합니다. 남은 재시도: ${retriesLeft}`
    };
  }

  return {
    action: 'fail',
    failedCommandIds,
    message: `검증 실패(${failedCommandIds.join(', ')}) 및 재시도 한도 초과`
  };
}

interface NameStatusEntry {
  status: string;
  path: string;
}

interface NumstatEntry {
  added: number;
  deleted: number;
  path: string;
}

function parseNameStatusOutput(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split('\t');
    const rawStatus = parts[0]?.trim() ?? '';
    const rawPath = parts.length >= 3 ? parts[2] : parts[1];
    const path = rawPath?.trim() ?? '';

    if (!rawStatus || !path) {
      continue;
    }

    entries.push({
      status: rawStatus[0] ?? rawStatus,
      path
    });
  }

  return entries;
}

function parseNumstatOutput(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split('\t');
    const addedRaw = parts[0]?.trim() ?? '';
    const deletedRaw = parts[1]?.trim() ?? '';
    const path = parts[2]?.trim() ?? '';

    if (!path) {
      continue;
    }

    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10);
    const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw, 10);

    if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
      continue;
    }

    entries.push({ added, deleted, path });
  }

  return entries;
}

function isFailedResult(result: CommandExecutionResult | undefined): boolean {
  if (!result) {
    return false;
  }

  return result.timedOut || result.exitCode !== 0;
}
