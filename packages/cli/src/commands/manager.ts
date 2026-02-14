import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { Command } from '../commander-shim.ts';

export interface ApprovalRequest {
  workflowName: string;
  phaseId: string;
  prompt: string;
  request: string;
  iteration: number;
}

export type ApprovalHandler = (input: ApprovalRequest) => Promise<boolean>;

export interface Provider {
  id: string;
  capabilities: {
    systemPromptMode: 'separate' | 'inline';
    supportsPatchOutput: boolean;
  };
  run(input: {
    systemPrompt: string;
    userPrompt: string;
    workspaceDir: string;
    timeoutMs?: number;
  }): Promise<{
    text: string;
    meta: {
      durationMs: number;
      stdout: string;
      stderr: string;
      command: string[];
      exitCode?: number | null;
      timedOut?: boolean;
    };
  }>;
}

export type ProviderResolver = (providerId: string, phase?: unknown) => Provider;

export interface OrchestratorRunResult {
  runDir: string;
  workflowName: string;
  state: {
    status: string;
  };
  executedPhases: string[];
  artifacts: Array<{
    relativePath: string;
  }>;
}

const DEFAULT_CHECK_COMMAND_IDS = ['build', 'test'];
const DEFAULT_MAX_AUTO_FIX_RETRIES = 2;

export interface ManagerCommandDependencies {
  cwd?: () => string;
  now?: () => Date;
  approvalHandler?: ApprovalHandler;
  providerResolver?: ProviderResolver;
  defaultProviderId?: string;
  checkCommandIds?: string[];
  maxAutoFixRetries?: number;
  toolsYamlText?: string;
  onRunCreated?: (event: ManagerRunCreatedEvent) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface ManagerRefactorResult {
  runId: string;
  runDir: string;
  summary: OrchestratorRunResult;
}

export interface ManagerRunCreatedEvent {
  runId: string;
  runDir: string;
}

export function registerManagerCommand(program: Command, dependencies: ManagerCommandDependencies = {}): void {
  const manager = program.command('manager').description('워크플로 매니저 명령');

  manager
    .command('refactor')
    .description('refactor workflow를 실행한다.')
    .action(async (args) => {
      const request = parseRefactorRequest(args);
      await runManagerRefactor(request, dependencies);
    });
}

export async function runManagerRefactor(
  request: string,
  dependencies: ManagerCommandDependencies = {}
): Promise<ManagerRefactorResult> {
  const coreRuntime = await loadCoreRuntime();
  const providersRuntime = await loadProvidersRuntime();

  const cwd = dependencies.cwd ?? (() => process.cwd());
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? ((message: string) => console.log(message));

  const rootDir = cwd();
  const workspacePath = path.resolve(rootDir, 'ai-dev-team');
  const workflowPath = path.resolve(workspacePath, 'config', 'workflows', 'refactor.yaml');

  const runRootDir = path.resolve(rootDir, '.runs', 'workflows');
  const runId = createRunId('refactor', now);
  const runDir = path.resolve(runRootDir, runId);

  await mkdir(runDir, { recursive: true });
  await dependencies.onRunCreated?.({ runId, runDir });

  const routingYaml = await readRoutingYaml(path.resolve(workspacePath, 'config', 'routing.yaml'));
  const fallbackProviderId = providersRuntime.resolveProviderId({
    routingYaml,
    fallbackProviderId: 'codex-cli'
  });

  const providerResolver =
    dependencies.providerResolver ?? createDefaultProviderResolver(providersRuntime);
  const defaultProviderId = dependencies.defaultProviderId ?? fallbackProviderId;
  const toolsYaml =
    dependencies.toolsYamlText ??
    (await readRequiredTextFile(path.resolve(workspacePath, 'config', 'tools.yaml'), 'tools.yaml'));
  const gatekeeperYaml = await readOptionalTextFile(path.resolve(workspacePath, 'config', 'gatekeeper.yaml'));
  const gatekeeperConfig = parseGatekeeperYaml(gatekeeperYaml);
  const toolsConfig = coreRuntime.parseToolsYaml(toolsYaml);
  const commandRunner = new coreRuntime.CommandRunner({
    workspaceDir: rootDir,
    runDir,
    tools: toolsConfig
  });
  const gatekeeper = new coreRuntime.Gatekeeper({
    commandRunner
  });
  const checkCommandIds = normalizeCheckCommandIds(
    dependencies.checkCommandIds ?? gatekeeperConfig.checkCommandIds ?? DEFAULT_CHECK_COMMAND_IDS
  );
  const maxAutoFixRetries = normalizeAutoFixRetries(
    dependencies.maxAutoFixRetries ??
      gatekeeperConfig.maxAutoFixRetries ??
      DEFAULT_MAX_AUTO_FIX_RETRIES
  );

  const orchestrator = new coreRuntime.Orchestrator({
    providerResolver,
    approvalHandler: dependencies.approvalHandler ?? createTerminalApprovalHandler(log),
    gatekeeper,
    checkCommandIds,
    maxAutoFixRetries
  });

  const summary = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir: rootDir,
    request,
    defaultProviderId
  });

  log(`run id: ${runId}`);
  log(`상태: ${summary.state.status}`);
  log(`실행 phase: ${summary.executedPhases.join(' -> ')}`);
  log(`아티팩트 수: ${summary.artifacts.length}`);
  log(`상태 파일: ${path.join(runDir, 'current-run.json')}`);

  return {
    runId,
    runDir,
    summary
  };
}

function parseRefactorRequest(args: string[]): string {
  if (args.length === 0) {
    throw new Error('요청 문장을 입력해야 합니다. 예: adt manager refactor "함수 분리"');
  }

  for (const arg of args) {
    if (arg.startsWith('-')) {
      throw new Error(`지원하지 않는 옵션입니다: ${arg}`);
    }
  }

  const request = args.join(' ').trim();
  if (!request) {
    throw new Error('요청 문장은 비어 있을 수 없습니다.');
  }

  return request;
}

function createRunId(workflowName: string, nowFactory: () => Date): string {
  const now = nowFactory().toISOString().replaceAll(':', '').replaceAll('-', '').replaceAll('.', '');
  const suffix = randomUUID().slice(0, 8);
  return `${workflowName}-${now}-${suffix}`;
}

function createDefaultProviderResolver(providersRuntime: ProvidersRuntimeModule): ProviderResolver {
  const registry = providersRuntime.createProviderRegistry();
  const cache = new Map<string, Provider>();

  return (providerId) => {
    const id = providerId.trim();

    if (!cache.has(id)) {
      cache.set(id, registry.create(id));
    }

    const provider = cache.get(id);
    if (!provider) {
      throw new Error(`provider를 생성하지 못했습니다: ${id}`);
    }

    return provider;
  };
}

function createTerminalApprovalHandler(log: (message: string) => void): ApprovalHandler {
  return async ({ prompt }) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });

    try {
      log('[manager] 승인 단계');
      const answer = await readline.question(`${prompt}\n승인할까요? (y/N): `);
      return /^y(?:es)?$/i.test(answer.trim());
    } finally {
      readline.close();
    }
  };
}

async function readRoutingYaml(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function readRequiredTextFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`${label} 파일이 없습니다: ${filePath}`);
    }

    throw error;
  }
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function normalizeCheckCommandIds(input: string[]): string[] {
  const normalized = input.map((id) => id.trim()).filter(Boolean);
  const unique = new Set(normalized);
  return [...unique];
}

function normalizeAutoFixRetries(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`maxAutoFixRetries는 0~10 정수여야 합니다: ${value}`);
  }

  return value;
}

function parseGatekeeperYaml(yamlText: string | undefined): {
  checkCommandIds?: string[];
  maxAutoFixRetries?: number;
} {
  if (!yamlText) {
    return {};
  }

  const lines = yamlText.split(/\r?\n/);
  const commandIds: string[] = [];

  let maxAutoFixRetries: number | undefined;
  let inChecks = false;
  let inCommandIds = false;

  for (const originalLine of lines) {
    const line = stripLineComment(originalLine).trimEnd();

    if (!line.trim()) {
      continue;
    }

    const indentation = countLeadingSpaces(line);
    const trimmed = line.trim();

    if (trimmed.startsWith('max_retries:')) {
      const raw = trimmed.slice('max_retries:'.length).trim();
      const parsed = Number.parseInt(raw, 10);

      if (Number.isInteger(parsed) && parsed >= 0) {
        maxAutoFixRetries = parsed;
      }
    }

    if (indentation === 0) {
      inChecks = trimmed === 'checks:';
      inCommandIds = false;
      continue;
    }

    if (!inChecks) {
      continue;
    }

    if (indentation === 2 && trimmed === 'command_ids:') {
      inCommandIds = true;
      continue;
    }

    if (indentation <= 2) {
      inCommandIds = false;
      continue;
    }

    if (inCommandIds && trimmed.startsWith('- ')) {
      const id = trimmed.slice(2).trim();
      if (id) {
        commandIds.push(id);
      }
    }
  }

  return {
    ...(commandIds.length > 0 ? { checkCommandIds: commandIds } : {}),
    ...(maxAutoFixRetries !== undefined ? { maxAutoFixRetries } : {})
  };
}

function stripLineComment(line: string): string {
  const commentIndex = line.indexOf('#');

  if (commentIndex === -1) {
    return line;
  }

  return line.slice(0, commentIndex);
}

function countLeadingSpaces(value: string): number {
  let count = 0;

  while (count < value.length && value[count] === ' ') {
    count += 1;
  }

  return count;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

interface RuntimeToolsConfig {
  commands: Array<{
    id: string;
    executable: string;
    args: string[];
    timeoutMs?: number;
  }>;
}

interface RuntimeCommandRunner {
  run(input: { commandId: string; timeoutMs?: number; stdin?: string }): Promise<{
    commandId: string;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
  }>;
}

interface RuntimeGatekeeper {
  inspectChanges(): Promise<{
    requiresApproval: boolean;
    reasons: string[];
    deletedFiles: string[];
    securitySensitiveFiles: string[];
    changedFileCount: number;
    totalChangedLines: number;
  }>;
  runChecks(commandIds: string[]): Promise<Array<{
    commandId: string;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
  }>>;
  decideCheckFailure(input: {
    checkResults: Array<{
      commandId: string;
      command: string[];
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
    }>;
    retryCount: number;
    maxAutoFixRetries: number;
  }): {
    action: 'pass' | 'auto_fix' | 'fail';
    failedCommandIds: string[];
    message: string;
  };
}

interface CoreRuntimeModule {
  Orchestrator: new (options: {
    providerResolver: ProviderResolver;
    approvalHandler?: ApprovalHandler;
    gatekeeper?: RuntimeGatekeeper;
    checkCommandIds?: string[];
    maxAutoFixRetries?: number;
  }) => {
    run(input: {
      workflowPath: string;
      runDir: string;
      workspaceDir: string;
      request: string;
      defaultProviderId?: string;
    }): Promise<OrchestratorRunResult>;
  };
  parseToolsYaml: (yamlText: string) => RuntimeToolsConfig;
  CommandRunner: new (options: {
    workspaceDir: string;
    runDir: string;
    tools: RuntimeToolsConfig;
    defaultTimeoutMs?: number;
    logRelativePath?: string;
  }) => RuntimeCommandRunner;
  Gatekeeper: new (options: {
    commandRunner: RuntimeCommandRunner;
  }) => RuntimeGatekeeper;
}

interface ProvidersRuntimeModule {
  createProviderRegistry: () => {
    create(providerId: string): Provider;
  };
  resolveProviderId: (options: {
    providerId?: string;
    routingYaml?: string;
    fallbackProviderId?: string;
  }) => string;
}

async function loadCoreRuntime(): Promise<CoreRuntimeModule> {
  try {
    return (await import('../../../core/src/index.ts')) as CoreRuntimeModule;
  } catch {
    return (await import('../../../core/dist/index.js')) as CoreRuntimeModule;
  }
}

async function loadProvidersRuntime(): Promise<ProvidersRuntimeModule> {
  try {
    return (await import('../../../providers/src/index.ts')) as ProvidersRuntimeModule;
  } catch {
    return (await import('../../../providers/dist/index.js')) as ProvidersRuntimeModule;
  }
}
