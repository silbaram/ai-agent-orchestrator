#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { emitKeypressEvents } from 'node:readline';

const POLL_INTERVAL_MS = 500;
const MAX_ARTIFACT_ROWS = 12;
const MAX_LOG_ROWS = 8;
const MAX_PROMPT_ROWS = 12;

interface RunStatePhase {
  id: string;
  status: string;
  error?: string;
}

interface RunStateFile {
  status: string;
  current_phase: string | null;
  retries: number;
  phases: RunStatePhase[];
  artifacts: Record<string, string[]>;
}

interface ArtifactRecord {
  phase: string;
  name: string;
  relativePath: string;
  bytes: number;
  updatedAt: string;
}

interface ArtifactIndexFile {
  artifacts: ArtifactRecord[];
  updatedAt: string;
}

interface ApprovalRequest {
  workflowName: string;
  phaseId: string;
  prompt: string;
  request: string;
  iteration: number;
}

interface ManagerRunCreatedEvent {
  runId: string;
  runDir: string;
}

interface ManagerRuntimeDependencies {
  onRunCreated?: (event: ManagerRunCreatedEvent) => void | Promise<void>;
  approvalHandler?: (input: ApprovalRequest) => Promise<boolean>;
  log?: (message: string) => void;
}

interface ManagerRefactorResult {
  runId: string;
  runDir: string;
  summary: {
    state: {
      status: string;
    };
    executedPhases: string[];
    artifacts: ArtifactRecord[];
  };
}

interface ManagerRuntimeModule {
  runManagerRefactor(
    request: string,
    dependencies?: ManagerRuntimeDependencies
  ): Promise<ManagerRefactorResult>;
}

interface ParsedArguments {
  help: boolean;
  request: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
}

class TuiApp {
  private runId: string | null = null;
  private runDir: string | null = null;
  private state: RunStateFile | null = null;
  private artifacts: ArtifactRecord[] = [];
  private logs: string[] = [];
  private pendingApproval: PendingApproval | null = null;
  private showFullPrompt = false;
  private lastApprovalResult = '없음';
  private finished = false;
  private statusOverride: string | null = null;
  private fatalError: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private started = false;

  constructor(private readonly interactive: boolean) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;

    if (this.interactive) {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', this.handleKeypress);
    }

    this.pollTimer = setInterval(() => {
      void this.refreshAndRender();
    }, POLL_INTERVAL_MS);

    this.render();
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.interactive) {
      process.stdin.off('keypress', this.handleKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }

  setRunContext(event: ManagerRunCreatedEvent): void {
    this.runId = event.runId;
    this.runDir = event.runDir;
    this.appendLog(`run 생성: ${event.runId}`);
  }

  appendLog(message: string): void {
    const now = new Date().toISOString();
    this.logs.push(`[${now}] ${message}`);

    if (this.logs.length > MAX_LOG_ROWS) {
      this.logs = this.logs.slice(this.logs.length - MAX_LOG_ROWS);
    }
  }

  async requestApproval(input: ApprovalRequest): Promise<boolean> {
    if (!this.interactive) {
      this.lastApprovalResult = `자동 승인(비TTY): phase=${input.phaseId}`;
      this.appendLog(this.lastApprovalResult);
      return true;
    }

    if (this.pendingApproval) {
      this.pendingApproval.resolve(false);
    }

    this.showFullPrompt = false;
    this.pendingApproval = {
      request: input,
      resolve: (approved: boolean) => {
        this.lastApprovalResult = `${approved ? '승인' : '거절'}: phase=${input.phaseId}`;
        this.pendingApproval = null;
        this.showFullPrompt = false;
        this.appendLog(`승인 입력 처리: ${this.lastApprovalResult}`);
      }
    };

    this.render();

    return new Promise<boolean>((resolve) => {
      const pending = this.pendingApproval;

      if (!pending) {
        resolve(false);
        return;
      }

      pending.resolve = (approved: boolean) => {
        this.lastApprovalResult = `${approved ? '승인' : '거절'}: phase=${input.phaseId}`;
        this.pendingApproval = null;
        this.showFullPrompt = false;
        this.appendLog(`승인 입력 처리: ${this.lastApprovalResult}`);
        resolve(approved);
      };
    });
  }

  setFinished(status: string): void {
    this.finished = true;
    this.statusOverride = status;
  }

  setFailure(errorMessage: string): void {
    this.finished = true;
    this.statusOverride = 'failed';
    this.fatalError = errorMessage;
    this.appendLog(`실패: ${errorMessage}`);
  }

  async refreshNow(): Promise<void> {
    await this.refreshFromDisk();
  }

  render(): void {
    const lines: string[] = [];
    const status = this.state?.status ?? this.statusOverride ?? 'starting';
    const phase = this.state?.current_phase ?? '-';
    const retries = this.state?.retries ?? 0;
    const lastError = this.findLastError() ?? this.fatalError ?? '-';

    lines.push('AAO TUI (Phase 08)');
    lines.push('');
    lines.push(`[Run] id=${this.runId ?? '(생성 중)'}`);
    lines.push(`dir=${this.runDir ?? '(미정)'}`);
    lines.push('');
    lines.push('[현재 상태]');
    lines.push(`status: ${status}`);
    lines.push(`phase: ${phase}`);
    lines.push(`retries: ${retries}`);
    lines.push(`last error: ${lastError}`);
    lines.push('');
    lines.push('[Artifacts]');

    const artifactsToShow = this.getArtifactsForDisplay();
    if (artifactsToShow.length === 0) {
      lines.push('- 없음');
    } else {
      for (const artifact of artifactsToShow) {
        const size = artifact.bytes > 0 ? `${artifact.bytes}B` : '-';
        lines.push(`- ${artifact.relativePath} (${size})`);
      }
    }

    lines.push('');
    lines.push('[승인 요청]');

    if (this.pendingApproval) {
      const request = this.pendingApproval.request;
      lines.push(`workflow: ${request.workflowName}`);
      lines.push(`phase: ${request.phaseId}`);
      lines.push(`iteration: ${request.iteration}`);
      lines.push('선택: 1) 승인  2) 거절  3) 프롬프트 토글');

      if (this.showFullPrompt) {
        lines.push('prompt:');

        const promptLines = clampLines(request.prompt, MAX_PROMPT_ROWS);
        for (const promptLine of promptLines) {
          lines.push(`> ${promptLine}`);
        }
      }
    } else {
      lines.push('대기 중인 요청 없음');
    }

    lines.push(`마지막 처리 결과: ${this.lastApprovalResult}`);
    lines.push('');
    lines.push('[로그]');

    if (this.logs.length === 0) {
      lines.push('- 없음');
    } else {
      for (const log of this.logs) {
        lines.push(`- ${log}`);
      }
    }

    if (this.finished) {
      lines.push('');
      lines.push(`run 종료 상태: ${status}`);
    }

    const output = `${lines.join('\n')}\n`;

    if (this.interactive) {
      process.stdout.write('\u001B[2J\u001B[0;0H');
    }

    process.stdout.write(output);
  }

  private readonly handleKeypress = (char: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.ctrl && key.name === 'c') {
      void this.exitFromSignal();
      return;
    }

    if (!this.pendingApproval) {
      return;
    }

    if (char === '1') {
      this.pendingApproval.resolve(true);
      this.render();
      return;
    }

    if (char === '2') {
      this.pendingApproval.resolve(false);
      this.render();
      return;
    }

    if (char === '3') {
      this.showFullPrompt = !this.showFullPrompt;
      this.render();
    }
  };

  private async exitFromSignal(): Promise<void> {
    await this.dispose();
    process.exit(130);
  }

  private async refreshAndRender(): Promise<void> {
    await this.refreshFromDisk();
    this.render();
  }

  private async refreshFromDisk(): Promise<void> {
    if (!this.runDir || this.refreshing) {
      return;
    }

    this.refreshing = true;

    try {
      const statePath = path.resolve(this.runDir, 'current-run.json');
      const state = await readJsonIfExists<RunStateFile>(statePath);

      if (state) {
        this.state = state;
      }

      const indexPath = path.resolve(this.runDir, 'artifacts', 'index.json');
      const index = await readJsonIfExists<ArtifactIndexFile | ArtifactRecord[]>(indexPath);

      if (Array.isArray(index)) {
        this.artifacts = index;
      } else if (index && Array.isArray(index.artifacts)) {
        this.artifacts = index.artifacts;
      } else if (this.state) {
        this.artifacts = flattenArtifactsFromState(this.state);
      }
    } catch (error) {
      this.appendLog(`상태 갱신 실패: ${toErrorMessage(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private findLastError(): string | null {
    if (!this.state) {
      return null;
    }

    for (let index = this.state.phases.length - 1; index >= 0; index -= 1) {
      const phase = this.state.phases[index];
      if (phase?.error) {
        return phase.error;
      }
    }

    return null;
  }

  private getArtifactsForDisplay(): ArtifactRecord[] {
    const byRecent = [...this.artifacts].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || '');
      const rightTime = Date.parse(right.updatedAt || '');

      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && rightTime !== leftTime) {
        return rightTime - leftTime;
      }

      return right.relativePath.localeCompare(left.relativePath);
    });

    return byRecent.slice(0, MAX_ARTIFACT_ROWS);
  }
}

function parseArguments(argv: string[]): ParsedArguments {
  if (argv.includes('-h') || argv.includes('--help')) {
    return {
      help: true,
      request: ''
    };
  }

  for (const arg of argv) {
    if (arg.startsWith('-')) {
      throw new Error(`지원하지 않는 옵션입니다: ${arg}`);
    }
  }

  const request = argv.join(' ').trim();

  if (!request) {
    throw new Error('요청 문장을 입력해야 합니다. 예: adt-tui "함수 분리"');
  }

  return {
    help: false,
    request
  };
}

function printHelp(): void {
  const lines = [
    'Usage: adt-tui "요청 문장"',
    '',
    '예시:',
    '  adt-tui "logger 모듈 분리"',
    '',
    '키 입력:',
    '  1 승인',
    '  2 거절',
    '  3 승인 프롬프트 펼치기/접기',
    '  Ctrl+C 종료'
  ];

  console.log(lines.join('\n'));
}

function clampLines(text: string, maxLines: number): string[] {
  const lines = text.split(/\r?\n/);

  if (lines.length <= maxLines) {
    return lines;
  }

  return [...lines.slice(0, maxLines - 1), '...[truncated]'];
}

function flattenArtifactsFromState(state: RunStateFile): ArtifactRecord[] {
  const result: ArtifactRecord[] = [];
  const seen = new Set<string>();

  for (const [phase, paths] of Object.entries(state.artifacts)) {
    for (const relativePath of paths) {
      if (seen.has(relativePath)) {
        continue;
      }

      seen.add(relativePath);

      const prefix = `${phase}/`;
      const name = relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;

      result.push({
        phase,
        name,
        relativePath,
        bytes: 0,
        updatedAt: ''
      });
    }
  }

  return result;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadManagerRuntime(): Promise<ManagerRuntimeModule> {
  try {
    return (await import('../../cli/src/commands/manager.ts')) as ManagerRuntimeModule;
  } catch {
    return (await import('../../cli/dist/commands/manager.js')) as ManagerRuntimeModule;
  }
}

function printFinalSummary(result: ManagerRefactorResult): void {
  console.log('');
  console.log('[TUI 요약]');
  console.log(`run id: ${result.runId}`);
  console.log(`run dir: ${result.runDir}`);
  console.log(`status: ${result.summary.state.status}`);
  console.log(`executed phases: ${result.summary.executedPhases.join(' -> ')}`);
  console.log(`artifacts: ${result.summary.artifacts.length}`);
}

function printManagerMessages(result: ManagerRefactorResult): Promise<void> {
  const managerArtifacts = result.summary.artifacts.filter((artifact) =>
    artifact.relativePath.endsWith('.manager-update.md')
  );

  if (!managerArtifacts.length) {
    return Promise.resolve();
  }

  return readManagerMessages(result.runDir, managerArtifacts).then((messages) => {
    if (!messages.length) {
      return;
    }

    console.log('');
    console.log('[Manager 메시지]');

    for (const message of messages) {
      console.log('');
      console.log(message);
    }
  });
}

async function readManagerMessages(
  runDir: string,
  artifacts: ArtifactRecord[]
): Promise<string[]> {
  const managerArtifacts = artifacts
    .filter((artifact) => artifact.relativePath.endsWith('.manager-update.md'))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const messages: string[] = [];

  for (const artifact of managerArtifacts) {
    const message = await readFile(path.resolve(runDir, artifact.relativePath), 'utf8');
    messages.push(message);
  }

  return messages;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const runtime = await loadManagerRuntime();
  const app = new TuiApp(isInteractiveTerminal());

  app.start();
  app.appendLog('workflow 실행 시작');

  try {
    const result = await runtime.runManagerRefactor(args.request, {
      onRunCreated: (event) => {
        app.setRunContext(event);
      },
      approvalHandler: async (input) => app.requestApproval(input),
      log: (message) => {
        app.appendLog(message);
      }
    });

    app.setRunContext({
      runId: result.runId,
      runDir: result.runDir
    });
    await app.refreshNow();
    app.setFinished(result.summary.state.status);
    app.render();
    await app.dispose();
    printFinalSummary(result);
    await printManagerMessages(result);
  } catch (error) {
    const message = toErrorMessage(error);
    app.setFailure(message);
    app.render();
    await app.dispose();
    console.error(`실행 실패: ${message}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = toErrorMessage(error);
  console.error(`예상치 못한 오류: ${message}`);
  process.exit(1);
});
