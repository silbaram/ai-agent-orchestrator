import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    current_phase: string | null;
    phases: Array<{
      id: string;
      status: string;
    }>;
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
  summaryPath: string;
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
      const request = parseManagerRequest(args);
      await runManagerRefactor(request, dependencies);
    });

  manager
    .command('feature-order-page')
    .description('기존 feature-order-page 템플릿 workflow를 실행한다.')
    .action(async (args) => {
      const request = parseManagerRequest(args);
      await runManagerWorkflow('feature-order-page', request, dependencies);
    });

  manager
    .command('feature')
    .description('일반 feature workflow를 실행한다.')
    .action(async (args) => {
      const request = parseManagerRequest(args);
      await runManagerWorkflow('feature', request, dependencies);
    });
}

export async function runManagerRefactor(
  request: string,
  dependencies: ManagerCommandDependencies = {}
): Promise<ManagerRefactorResult> {
  return runManagerWorkflow('refactor', request, dependencies);
}

export async function runManagerWorkflow(
  workflowName: string,
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
  const workflowPath = path.resolve(workspacePath, 'config', 'workflows', `${workflowName}.yaml`);

  const runRootDir = path.resolve(rootDir, '.runs', 'workflows');
  const runId = createRunId(workflowName, now);
  const runDir = path.resolve(runRootDir, runId);

  await mkdir(runDir, { recursive: true });
  await dependencies.onRunCreated?.({ runId, runDir });

  const routingYaml = await readRoutingYaml(path.resolve(workspacePath, 'config', 'routing.yaml'));
  const fallbackProviderId = providersRuntime.resolveProviderId({
    routingYaml,
    fallbackProviderId: 'codex-cli'
  });
  const roleProviderMap = parseRoleProviderMap(
    routingYaml ? providersRuntime.parseRoutingYaml(routingYaml) : undefined
  );

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
    defaultProviderId,
    roleProviderMap
  });
  const summaryPath = path.resolve(runDir, 'summary.md');
  await writeFile(
    summaryPath,
    createRunSummaryText({
      workflowName,
      request,
      runDir,
      state: summary.state,
      executedPhases: summary.executedPhases,
      artifacts: summary.artifacts
    }),
    'utf8'
  );
  const managerMessages = await readManagerMessages(runDir, summary.artifacts);
  for (const message of managerMessages) {
    log('[Manager 메시지]');
    log(message);
  }

  log(`run id: ${runId}`);
  log(`상태: ${summary.state.status}`);
  log(`실행 phase: ${summary.executedPhases.join(' -> ')}`);
  log(`아티팩트 수: ${summary.artifacts.length}`);
  log(`상태 파일: ${path.join(runDir, 'current-run.json')}`);
  log(`요약 파일: ${summaryPath}`);

  return {
    runId,
    runDir,
    summary,
    summaryPath
  };
}

async function readManagerMessages(
  runDir: string,
  artifacts: Array<{ phase: string; relativePath: string }>
): Promise<string[]> {
  const managerArtifacts = artifacts
    .filter((artifact) => artifact.relativePath.endsWith('.manager-update.md'))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const messages: string[] = [];

  for (const artifact of managerArtifacts) {
    const text = await readFile(path.resolve(runDir, artifact.relativePath), 'utf8');
    messages.push(text);
  }

  return messages;
}

function parseManagerRequest(args: string[]): string {
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

function parseRoleProviderMap(routingConfig: { roles?: Record<string, string> } | undefined): Record<string, string> {
  if (!routingConfig?.roles) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [rawRole, rawProviderId] of Object.entries(routingConfig.roles)) {
    const role = rawRole.trim().toLowerCase();
    const providerId = rawProviderId.trim();

    if (role && providerId) {
      normalized[role] = providerId;
    }
  }

  return normalized;
}

function createRunSummaryText(options: {
  workflowName: string;
  request: string;
  runDir: string;
  state: {
    status: string;
    current_phase: string | null;
    phases: Array<{ id: string; status: string }>;
  };
  executedPhases: string[];
  artifacts: Array<{ phase: string; relativePath: string }>;
}): string {
  const phaseTimeline = options.executedPhases.length
    ? options.executedPhases.map((phase, index) => `- ${index + 1}. ${phase}`).join('\n')
    : '- 실행된 phase가 없습니다.';

  const phaseSummaryRows = options.state.phases.map(
    (phase) => `| ${phase.id} | ${phase.status} |`
  );

  const artifactsByPhase = buildArtifactsByPhase(options.artifacts);
  const artifactSummaryRows = options.state.phases.map((phase) => {
    const phaseArtifacts = artifactsByPhase.get(phase.id) ?? [];
    const artifactsText = phaseArtifacts.length
      ? phaseArtifacts.map((artifactPath) => `  - ${artifactPath}`).join('\n')
      : '  - (없음)';

    return [`- ${phase.id} (${phase.status})`, artifactsText].join('\n');
  });

  const summaryLines = [
    '# AAO 실행 요약',
    `- workflow: ${options.workflowName}`,
    `- request: ${options.request}`,
    `- status: ${options.state.status}`,
    `- current_phase: ${options.state.current_phase ?? 'none'}`,
    '',
    '## 실행 phase',
    phaseTimeline,
    '',
    '## phase 상태',
    '| phase | status |',
    '| --- | --- |',
    ...phaseSummaryRows,
    '',
    '## phase별 아티팩트',
    ...artifactSummaryRows,
    '',
    '## 아티팩트',
    options.artifacts.length > 0
      ? options.artifacts.map((artifact) => `- ${artifact.relativePath}`).join('\n')
      : '- 아티팩트가 없습니다.',
    '',
    '## 위치',
    `- runDir: ${path.resolve(options.runDir)}`,
    `- current-run: ${path.resolve(options.runDir, 'current-run.json')}`,
    `- log: ${path.resolve(options.runDir, 'logs')}`,
    `- artifacts: ${path.resolve(options.runDir, 'artifacts')}`,
    '',
    `총 아티팩트 개수: ${options.artifacts.length}개`
  ];

  if (!options.artifacts.length) {
    summaryLines.push('- 최근에 생성된 아티팩트가 없습니다.');
  }

  return [
    ...summaryLines
  ].join('\n');
}

function buildArtifactsByPhase(
  artifacts: Array<{ phase: string; relativePath: string }>
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const artifact of artifacts) {
    const phase = artifact.phase.trim();
    const paths = grouped.get(phase) ?? [];
    paths.push(artifact.relativePath);
    grouped.set(phase, paths);
  }

  return grouped;
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
