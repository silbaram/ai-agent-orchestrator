import { spawn } from 'node:child_process';
import path from 'node:path';

export type PatchSource = 'diff_code_block' | 'patch_code_block' | 'patch_section';

export interface ExtractedPatch {
  patch: string;
  source: PatchSource;
}

export type PatchExtractionFailureReason = 'not_found' | 'invalid_format' | 'path_violation';
export type PatchApplyFailureReason =
  | 'context_mismatch'
  | 'invalid_patch'
  | 'not_git_repository'
  | 'path_violation'
  | 'timeout'
  | 'unknown';

export class PatchExtractionError extends Error {
  readonly reason: PatchExtractionFailureReason;

  constructor(message: string, reason: PatchExtractionFailureReason) {
    super(message);
    this.name = 'PatchExtractionError';
    this.reason = reason;
  }
}

export interface PatchApplyErrorContext {
  reason: PatchApplyFailureReason;
  stderr?: string;
  command?: string[];
  exitCode?: number | null;
}

export class PatchApplyError extends Error {
  readonly reason: PatchApplyFailureReason;
  readonly stderr: string;
  readonly command: string[];
  readonly exitCode?: number | null;

  constructor(message: string, context: PatchApplyErrorContext) {
    super(message);
    this.name = 'PatchApplyError';
    this.reason = context.reason;
    this.stderr = context.stderr ?? '';
    this.command = context.command ?? [];
    this.exitCode = context.exitCode;
  }
}

export interface ApplyPatchInput {
  workspaceDir: string;
  patch: string;
  gitBinary?: string;
  timeoutMs?: number;
  commandRunner?: GitCommandRunner;
}

export interface ApplyPatchResult {
  command: string[];
  stdout: string;
  stderr: string;
}

export interface CaptureDiffInput {
  workspaceDir: string;
  gitBinary?: string;
  timeoutMs?: number;
  commandRunner?: GitCommandRunner;
}

export interface CapturedDiff {
  diffStat: string;
  diff: string;
}

interface GitCommandInput {
  workspaceDir: string;
  gitBinary: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
}

type GitCommandRunner = (input: GitCommandInput) => Promise<GitCommandResult>;

const DEFAULT_GIT_BINARY = 'git';
const DEFAULT_TIMEOUT_MS = 15_000;

const FENCED_BLOCK_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const PATCH_SECTION_PATTERN = /^###\s*PATCH\b/i;
const NEXT_SECTION_PATTERN = /^###\s+\S/;

export function extractPatchFromText(text: string): ExtractedPatch {
  const normalizedText = text.trim();

  if (!normalizedText) {
    throw new PatchExtractionError('patch 추출 실패: 응답 텍스트가 비어 있습니다.', 'not_found');
  }

  const diffBlock = findFencedBlock(normalizedText, 'diff');
  if (diffBlock) {
    return finalizePatch(diffBlock, 'diff_code_block');
  }

  const patchBlock = findFencedBlock(normalizedText, 'patch');
  if (patchBlock) {
    return finalizePatch(patchBlock, 'patch_code_block');
  }

  const section = findPatchSection(normalizedText);
  if (section) {
    return finalizePatch(section, 'patch_section');
  }

  throw new PatchExtractionError(
    'patch 추출 실패: ```diff```/```patch``` 블록 또는 ### PATCH 섹션을 찾지 못했습니다.',
    'not_found'
  );
}

export async function applyPatchToWorkspace(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const gitBinary = input.gitBinary ?? DEFAULT_GIT_BINARY;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandRunner = input.commandRunner ?? runGitCommand;
  const command = [gitBinary, 'apply', '--whitespace=nowarn', '-'];
  const patchPayload = input.patch.endsWith('\n') ? input.patch : `${input.patch}\n`;

  assertSafePatchPaths(patchPayload);

  let result: GitCommandResult;

  try {
    result = await commandRunner({
      workspaceDir,
      gitBinary,
      args: ['apply', '--whitespace=nowarn', '-'],
      stdin: patchPayload,
      timeoutMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PatchApplyError(`git apply 실행 실패: ${message}`, {
      reason: 'unknown',
      stderr: message,
      command
    });
  }

  if (result.timedOut) {
    throw new PatchApplyError(`git apply 타임아웃(${timeoutMs}ms)`, {
      reason: 'timeout',
      stderr: result.stderr,
      command: result.command,
      exitCode: result.exitCode
    });
  }

  if (result.exitCode !== 0) {
    const reason = classifyGitFailureReason(result.stderr);
    throw new PatchApplyError(
      `patch 적용 실패(${toReasonLabel(reason)}): ${result.stderr.trim() || `exitCode=${result.exitCode}`}`,
      {
        reason,
        stderr: result.stderr,
        command: result.command,
        exitCode: result.exitCode
      }
    );
  }

  return {
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function captureWorkingTreeDiff(input: CaptureDiffInput): Promise<CapturedDiff> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const gitBinary = input.gitBinary ?? DEFAULT_GIT_BINARY;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandRunner = input.commandRunner ?? runGitCommand;

  const diffStatResult = await runGitCommandOrThrow(
    commandRunner,
    {
      workspaceDir,
      gitBinary,
      args: ['diff', '--stat'],
      timeoutMs
    },
    'git diff --stat'
  );
  const diffResult = await runGitCommandOrThrow(
    commandRunner,
    {
      workspaceDir,
      gitBinary,
      args: ['diff'],
      timeoutMs
    },
    'git diff'
  );

  return {
    diffStat: diffStatResult.stdout.trimEnd(),
    diff: diffResult.stdout.trimEnd()
  };
}

function findFencedBlock(text: string, language: string): string | null {
  const matcher = new RegExp(FENCED_BLOCK_PATTERN);
  let match = matcher.exec(text);

  while (match) {
    const rawLanguage = match[1]?.trim().toLowerCase();
    const normalizedLanguage = rawLanguage?.split(/\s+/)[0];

    if (normalizedLanguage === language) {
      return match[2] ?? '';
    }

    match = matcher.exec(text);
  }

  return null;
}

function findPatchSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => PATCH_SECTION_PATTERN.test(line.trim()));

  if (sectionStart < 0) {
    return null;
  }

  const collected: string[] = [];

  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (NEXT_SECTION_PATTERN.test(line.trim())) {
      break;
    }

    collected.push(line);
  }

  return collected.join('\n');
}

function finalizePatch(rawPatch: string, source: PatchSource): ExtractedPatch {
  const normalizedPatch = normalizePatchText(rawPatch);
  assertPatchShape(normalizedPatch);
  assertSafePatchPaths(normalizedPatch);

  return {
    patch: normalizedPatch,
    source
  };
}

function normalizePatchText(text: string): string {
  let normalized = trimBlankLines(text);

  if (!normalized) {
    throw new PatchExtractionError('patch 추출 실패: patch 내용이 비어 있습니다.', 'invalid_format');
  }

  const marked = normalized.match(/\[PATCH_BEGIN\]\s*([\s\S]*?)\s*\[PATCH_END\]/m);
  if (marked?.[1]) {
    normalized = trimBlankLines(marked[1]);
  }

  if (!normalized) {
    throw new PatchExtractionError(
      'patch 추출 실패: [PATCH_BEGIN]/[PATCH_END] 사이 내용이 비어 있습니다.',
      'invalid_format'
    );
  }

  return normalized;
}

function trimBlankLines(value: string): string {
  return value.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
}

function assertPatchShape(patch: string): void {
  const hasDiffGitHeader = /^diff --git\s+/m.test(patch);
  const hasUnifiedHeaders = /^---\s+/m.test(patch) && /^\+\+\+\s+/m.test(patch) && /^@@\s+/m.test(patch);

  if (hasDiffGitHeader || hasUnifiedHeaders) {
    return;
  }

  throw new PatchExtractionError('patch 추출 실패: unified diff 형식을 찾지 못했습니다.', 'invalid_format');
}

function assertSafePatchPaths(patch: string): void {
  const lines = patch.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    const lineNumber = index + 1;

    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!match) {
        continue;
      }

      assertSafePathSegment(match[1], lineNumber);
      assertSafePathSegment(match[2], lineNumber);
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const rawPath = line.slice(4).split('\t')[0]?.trim() ?? '';
      const unquoted = unquotePatchPath(rawPath);
      if (unquoted === '/dev/null') {
        continue;
      }

      const normalized = unquoted.startsWith('a/') || unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
      assertSafePathSegment(normalized, lineNumber);
    }
  }
}

function assertSafePathSegment(rawPath: string, lineNumber: number): void {
  const candidate = unquotePatchPath(rawPath).replaceAll('\\', '/');
  if (!candidate) {
    throw new PatchExtractionError(`patch 경로가 비어 있습니다(line ${lineNumber}).`, 'path_violation');
  }

  if (path.posix.isAbsolute(candidate) || /^[a-zA-Z]:\//.test(candidate)) {
    throw new PatchExtractionError(
      `patch 경로는 상대 경로여야 합니다(line ${lineNumber}): ${rawPath}`,
      'path_violation'
    );
  }

  const segments = candidate.split('/');
  if (segments.includes('..')) {
    throw new PatchExtractionError(
      `patch 경로에 상위 디렉토리 이동(..)을 포함할 수 없습니다(line ${lineNumber}): ${rawPath}`,
      'path_violation'
    );
  }
}

function unquotePatchPath(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if (!trimmed || first !== '"' || last !== '"') {
    return trimmed;
  }

  return trimmed
    .slice(1, -1)
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function classifyGitFailureReason(stderr: string): PatchApplyFailureReason {
  const normalized = stderr.toLowerCase();

  if (
    normalized.includes('patch does not apply') ||
    normalized.includes('while searching for') ||
    normalized.includes('patch failed')
  ) {
    return 'context_mismatch';
  }

  if (normalized.includes('not a git repository')) {
    return 'not_git_repository';
  }

  if (
    normalized.includes('corrupt patch') ||
    normalized.includes('malformed patch') ||
    normalized.includes('unrecognized input')
  ) {
    return 'invalid_patch';
  }

  return 'unknown';
}

function toReasonLabel(reason: PatchApplyFailureReason): string {
  if (reason === 'context_mismatch') {
    return '컨텍스트 불일치';
  }

  if (reason === 'invalid_patch') {
    return 'patch 형식 오류';
  }

  if (reason === 'not_git_repository') {
    return 'git 저장소 아님';
  }

  if (reason === 'path_violation') {
    return '경로 안전 규칙 위반';
  }

  if (reason === 'timeout') {
    return '타임아웃';
  }

  return '알 수 없음';
}

async function runGitCommandOrThrow(
  commandRunner: GitCommandRunner,
  input: GitCommandInput,
  label: string
): Promise<GitCommandResult> {
  let result: GitCommandResult;

  try {
    result = await commandRunner(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PatchApplyError(`${label} 실행 실패: ${message}`, {
      reason: 'unknown',
      stderr: message,
      command: [input.gitBinary, ...input.args]
    });
  }

  if (result.timedOut) {
    throw new PatchApplyError(`${label} 타임아웃(${input.timeoutMs}ms)`, {
      reason: 'timeout',
      stderr: result.stderr,
      command: result.command,
      exitCode: result.exitCode
    });
  }

  if (result.exitCode !== 0) {
    const reason = classifyGitFailureReason(result.stderr);
    throw new PatchApplyError(
      `${label} 실패(${toReasonLabel(reason)}): ${result.stderr.trim() || `exitCode=${result.exitCode}`}`,
      {
        reason,
        stderr: result.stderr,
        command: result.command,
        exitCode: result.exitCode
      }
    );
  }

  return result;
}

async function runGitCommand(input: GitCommandInput): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.gitBinary, input.args, {
      cwd: input.workspaceDir,
      shell: false,
      stdio: 'pipe'
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
    }, input.timeoutMs);

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
        command: [input.gitBinary, ...input.args],
        exitCode,
        timedOut
      });
    });

    child.stdin.on('error', () => {
      // 타임아웃 또는 프로세스 조기 종료로 stdin이 먼저 닫힐 수 있다.
    });

    child.stdin.end(input.stdin ?? '');
  });
}
