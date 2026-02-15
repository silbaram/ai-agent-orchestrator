import { ArtifactStore, type ArtifactRecord } from './artifact-store.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandExecutionResult } from './command-runner.ts';
import { Gatekeeper } from './gatekeeper.ts';
import {
  applyPatchToWorkspace,
  captureWorkingTreeDiff,
  extractPatchFromText,
  PatchApplyError,
  PatchExtractionError
} from './patch-first.ts';
import { RunLogger } from './run-logger.ts';
import { createInitialRunState, StateStore, type RunState, type RunStatePhase } from './state-store.ts';
import { loadWorkflowFromFile, type LlmWorkflowPhase, type WorkflowDecision, type WorkflowPhase } from './workflow.ts';
import type { Provider } from './index.ts';

export interface ApprovalRequest {
  workflowName: string;
  phaseId: string;
  prompt: string;
  request: string;
  iteration: number;
}

export type ApprovalHandler = (input: ApprovalRequest) => Promise<boolean>;
export type ProviderResolver = (providerId: string, phase: LlmWorkflowPhase) => Provider;

export interface OrchestratorOptions {
  providerResolver: ProviderResolver;
  approvalHandler?: ApprovalHandler;
  gatekeeper?: Gatekeeper;
  checkCommandIds?: string[];
  maxAutoFixRetries?: number;
}

export interface OrchestratorRunInput {
  workflowPath: string;
  runDir: string;
  workspaceDir: string;
  request: string;
  defaultProviderId?: string;
  roleProviderMap?: Record<string, string>;
}

export interface OrchestratorRunResult {
  runDir: string;
  workflowName: string;
  state: RunState;
  executedPhases: string[];
  artifacts: ArtifactRecord[];
}

const PATCH_FIRST_ROLES = new Set(['developer', 'fixer']);
const DEFAULT_MAX_AUTO_FIX_RETRIES = 2;

export class Orchestrator {
  private readonly providerResolver: ProviderResolver;
  private readonly approvalHandler: ApprovalHandler;
  private readonly gatekeeper?: Gatekeeper;
  private readonly checkCommandIds: string[];
  private readonly maxAutoFixRetries: number;

  constructor(options: OrchestratorOptions) {
    this.providerResolver = options.providerResolver;
    this.approvalHandler = options.approvalHandler ?? defaultApprovalHandler;
    this.gatekeeper = options.gatekeeper;
    this.checkCommandIds = (options.checkCommandIds ?? []).map((id) => id.trim()).filter(Boolean);
    this.maxAutoFixRetries = normalizeAutoFixRetryCount(options.maxAutoFixRetries);
  }

  async run(input: OrchestratorRunInput): Promise<OrchestratorRunResult> {
    const workflow = await loadWorkflowFromFile(input.workflowPath);
    const phaseMap = new Map(workflow.phases.map((phase) => [phase.id, phase]));
    const fixPhaseId = findPhaseIdByRole(workflow.phases, 'fixer');
    const evaluatePhaseId = findPhaseIdByRole(workflow.phases, 'evaluator');

    const stateStore = new StateStore({ runDir: input.runDir });
    const artifactStore = new ArtifactStore({ runDir: input.runDir });
    const logger = new RunLogger({ runDir: input.runDir });

    const state = createInitialRunState({
      status: 'running',
      current_phase: workflow.entryPhase,
      phases: workflow.phases.map((phase) => ({
        id: phase.id,
        status: 'pending'
      })),
      artifacts: {}
    });

    const artifacts: ArtifactRecord[] = [];
    const executedPhases: string[] = [];
    const outputs = new Map<string, string>();

    await persistState(stateStore, state);
    await logger.append({ source: 'orchestrator' }, `workflow 시작: ${workflow.name}`);

    let currentPhaseId: string | null = workflow.entryPhase;
    let iteration = 0;
    let latestOutput = '';

    while (currentPhaseId) {
      if (iteration >= workflow.maxSteps) {
        state.status = 'failed';
        state.current_phase = currentPhaseId;
        await logger.append(
          { source: 'orchestrator' },
          {
            level: 'ERROR',
            message: 'max_steps 초과로 run 종료',
            context: {
              maxSteps: workflow.maxSteps
            }
          }
        );
        await persistState(stateStore, state);
        break;
      }

      const phase = phaseMap.get(currentPhaseId);
      if (!phase) {
        throw new Error(`phase를 찾을 수 없습니다: ${currentPhaseId}`);
      }

      iteration += 1;

      const phaseState = findPhaseState(state, phase.id);
      markPhaseRunning(phaseState);
      state.current_phase = phase.id;
      state.status = phase.type === 'approval' ? 'awaiting_approval' : 'running';
      await persistState(stateStore, state);

      try {
        if (phase.type === 'approval') {
          const prompt = renderTemplate(phase.promptTemplate, {
            request: input.request,
            workflowName: workflow.name,
            phaseId: phase.id,
            iteration,
            outputs,
            latestOutput
          });

          const approved = await this.approvalHandler({
            workflowName: workflow.name,
            phaseId: phase.id,
            prompt,
            request: input.request,
            iteration
          });

          const approvalRecord = await artifactStore.write({
            phase: phase.id,
            name: `${formatIteration(iteration)}.approval.txt`,
            content: [`prompt: ${prompt}`, `approved: ${approved ? 'yes' : 'no'}`].join('\n')
          });
          artifacts.push(approvalRecord);
          addArtifactToState(state, phase.id, approvalRecord.relativePath);

          const approvalText = approved ? 'APPROVED' : 'REJECTED';
          outputs.set(phase.id, approvalText);
          latestOutput = approvalText;

          markPhaseCompleted(phaseState);
          executedPhases.push(phase.id);

          await logger.append(
            { source: 'orchestrator', phase: phase.id },
            {
              message: '승인 phase 완료',
              context: {
                approved
              }
            }
          );

          if (phase.terminalStatus) {
            state.status = phase.terminalStatus;
            state.current_phase = null;
            await persistState(stateStore, state);
            break;
          }

          const nextPhaseId = approved ? phase.nextOnApprove : phase.nextOnReject;

          if (!nextPhaseId) {
            state.status = approved ? 'completed' : 'canceled';
            state.current_phase = null;
            await persistState(stateStore, state);
            break;
          }

          state.status = 'running';
          state.current_phase = nextPhaseId;
          await persistState(stateStore, state);

          currentPhaseId = nextPhaseId;
          continue;
        }

        const providerId =
          phase.provider?.trim() ||
          resolveProviderFromRole(input.roleProviderMap, phase.role) ||
          input.defaultProviderId?.trim();
        if (!providerId) {
          throw new Error(`phase(${phase.id})의 provider를 결정할 수 없습니다.`);
        }

        const provider = this.providerResolver(providerId, phase);
        const renderContext = {
          request: input.request,
          workflowName: workflow.name,
          phaseId: phase.id,
          role: phase.role,
          iteration,
          outputs,
          latestOutput
        };
        const systemPromptTemplate = await resolveSystemPromptTemplate({
          workspaceDir: input.workspaceDir,
          phase,
          fallbackTemplate: phase.systemPromptTemplate ?? `당신은 ${phase.role} 역할로 동작한다.`
        });
        const systemPrompt = renderTemplate(systemPromptTemplate, renderContext);
        const userPrompt = renderTemplate(phase.promptTemplate, {
          request: input.request,
          workflowName: workflow.name,
          phaseId: phase.id,
          role: phase.role,
          iteration,
          outputs,
          latestOutput
        });

        await logger.append(
          { source: 'provider', phase: phase.id },
          {
            message: 'provider.run 시작',
            context: {
              providerId,
              role: phase.role,
              iteration
            }
          }
        );

        const output = await provider.run({
          systemPrompt,
          userPrompt,
          workspaceDir: input.workspaceDir
        });

        const rawRecord = await artifactStore.write({
          phase: phase.id,
          name: `${formatIteration(iteration)}.raw.txt`,
          content: output.text
        });
        artifacts.push(rawRecord);
        addArtifactToState(state, phase.id, rawRecord.relativePath);

        let phaseOutputText = output.text;
        let nextPhaseOverride: string | undefined;
        let cancelRequestedByGatekeeper = false;
        let managerOutputRecord: ArtifactRecord | null = null;

        if (isManagerRole(phase.role)) {
          const managerUpdate = formatManagerUserUpdate(output.text);
          managerOutputRecord = await artifactStore.write({
            phase: phase.id,
            name: `${formatIteration(iteration)}.manager-update.md`,
            content: managerUpdate
          });
          phaseOutputText = managerUpdate;
        } else {
          const plannerArtifacts = await processPlannerPhaseArtifacts({
            phase,
            iteration,
            outputText: output.text,
            artifactStore
          });
          for (const artifact of plannerArtifacts) {
            artifacts.push(artifact);
            addArtifactToState(state, phase.id, artifact.relativePath);
          }

          const patchFirstArtifacts = await processPatchFirstPhase({
            phase,
            iteration,
            outputText: output.text,
            workspaceDir: input.workspaceDir,
            artifactStore,
            logger
          });

          for (const artifact of patchFirstArtifacts) {
            artifacts.push(artifact);
            addArtifactToState(state, phase.id, artifact.relativePath);
          }

          if (this.gatekeeper && isPatchFirstRole(phase.role)) {
            const gatekeeperResult = await handleGatekeeperAfterPatch({
              gatekeeper: this.gatekeeper,
              workflowName: workflow.name,
              phase,
              request: input.request,
              iteration,
              state,
              stateStore,
              artifactStore,
              logger,
              approvalHandler: this.approvalHandler,
              checkCommandIds: this.checkCommandIds,
              maxAutoFixRetries: this.maxAutoFixRetries,
              fixPhaseId,
              evaluatePhaseId
            });

            for (const artifact of gatekeeperResult.artifacts) {
              artifacts.push(artifact);
              addArtifactToState(state, phase.id, artifact.relativePath);
            }

            if (gatekeeperResult.evaluatorFeedback) {
              phaseOutputText = `${phaseOutputText}\n\n${gatekeeperResult.evaluatorFeedback}`;

              if (evaluatePhaseId) {
                outputs.set(evaluatePhaseId, gatekeeperResult.evaluatorFeedback);
              }

              latestOutput = gatekeeperResult.evaluatorFeedback;
            }

            nextPhaseOverride = gatekeeperResult.nextPhaseId;
            cancelRequestedByGatekeeper = gatekeeperResult.cancelRun;
          }
        }

        if (managerOutputRecord) {
          artifacts.push(managerOutputRecord);
          addArtifactToState(state, phase.id, managerOutputRecord.relativePath);
        }

        outputs.set(phase.id, phaseOutputText);
        latestOutput = phaseOutputText;

        markPhaseCompleted(phaseState);
        executedPhases.push(phase.id);

        await logger.append(
          { source: 'provider', phase: phase.id },
          {
            message: 'provider.run 완료',
            context: {
              providerId,
              durationMs: output.meta.durationMs,
              command: output.meta.command,
              exitCode: output.meta.exitCode
            }
          }
        );

        if (cancelRequestedByGatekeeper) {
          state.status = 'canceled';
          state.current_phase = null;
          await persistState(stateStore, state);
          break;
        }

        if (phase.terminalStatus) {
          state.status = phase.terminalStatus;
          state.current_phase = null;
          await persistState(stateStore, state);
          break;
        }

        const nextPhaseId = nextPhaseOverride ?? resolveNextPhaseId(phase, phaseOutputText);

        if (!nextPhaseId) {
          state.status = 'completed';
          state.current_phase = null;
          await persistState(stateStore, state);
          break;
        }

        state.current_phase = nextPhaseId;
        state.status = 'running';
        await persistState(stateStore, state);

        currentPhaseId = nextPhaseId;
      } catch (error) {
        const message = toErrorMessage(error);

        markPhaseFailed(phaseState, message);
        state.status = 'failed';
        state.current_phase = phase.id;

        await logger.append(
          { source: 'orchestrator', phase: phase.id },
          {
            level: 'ERROR',
            message: 'phase 실행 실패',
            context: {
              error: message
            }
          }
        );

        await persistState(stateStore, state);
        break;
      }
    }

    if (!currentPhaseId && state.status === 'running') {
      state.status = 'completed';
      state.current_phase = null;
      await persistState(stateStore, state);
    }

    await logger.append(
      { source: 'orchestrator' },
      {
        message: 'workflow 종료',
        context: {
          status: state.status,
          executedPhases
        }
      }
    );

    return {
      runDir: input.runDir,
      workflowName: workflow.name,
      state,
      executedPhases,
      artifacts
    };
  }
}

interface RenderContext {
  request: string;
  workflowName: string;
  phaseId: string;
  role?: string;
  iteration: number;
  outputs: Map<string, string>;
  latestOutput: string;
}

function renderTemplate(template: string, context: RenderContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    const resolved = resolveTemplateKey(key, context);
    return resolved ?? '';
  });
}

async function resolveSystemPromptTemplate(input: {
  workspaceDir: string;
  phase: LlmWorkflowPhase;
  fallbackTemplate: string;
}): Promise<string> {
  if (!input.phase.systemPromptFile) {
    return input.fallbackTemplate;
  }

  const workspaceRoot = path.resolve(input.workspaceDir);
  const promptPath = path.resolve(workspaceRoot, input.phase.systemPromptFile);
  const relativePath = path.relative(workspaceRoot, promptPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`system_prompt_file이 워크스페이스 바깥입니다: ${input.phase.systemPromptFile}`);
  }

  try {
    return await readFile(promptPath, 'utf8');
  } catch (error) {
    throw new Error(`system_prompt_file을 읽을 수 없습니다: ${input.phase.systemPromptFile} (${toErrorMessage(error)})`);
  }
}

function resolveTemplateKey(key: string, context: RenderContext): string | undefined {
  if (key === 'request') {
    return context.request;
  }

  if (key === 'workflow.name') {
    return context.workflowName;
  }

  if (key === 'phase.id') {
    return context.phaseId;
  }

  if (key === 'phase.role') {
    return context.role;
  }

  if (key === 'iteration') {
    return String(context.iteration);
  }

  if (key === 'latest_output') {
    return context.latestOutput;
  }

  const outputMatch = key.match(/^phase\.([a-zA-Z0-9_-]+)\.output$/);
  if (outputMatch) {
    const phaseId = outputMatch[1];
    return phaseId ? context.outputs.get(phaseId) : undefined;
  }

  return undefined;
}

function resolveNextPhaseId(phase: LlmWorkflowPhase, outputText: string): string | undefined {
  if (phase.decisionSource === 'output_tag') {
    const decision = parseDecisionFromOutput(outputText);

    if (decision === 'pass') {
      return phase.nextOnPass ?? phase.next;
    }

    if (decision === 'fix') {
      return phase.nextOnFix ?? phase.next;
    }

    return phase.nextOnAsk ?? phase.next;
  }

  return phase.next;
}

function parseDecisionFromOutput(text: string): WorkflowDecision {
  const explicit = text.match(/DECISION\s*:\s*(PASS|FIX|ASK)\b/i);
  if (explicit?.[1]) {
    return explicit[1].toLowerCase() as WorkflowDecision;
  }

  if (/\[ASK\]/i.test(text) || /\bASK\b/i.test(text)) {
    return 'ask';
  }

  if (/\[FIX\]/i.test(text) || /\[FAIL\]/i.test(text) || /\bFIX\b/i.test(text)) {
    return 'fix';
  }

  return 'pass';
}

function findPhaseState(state: RunState, phaseId: string): RunStatePhase {
  const found = state.phases.find((phase) => phase.id === phaseId);

  if (!found) {
    throw new Error(`state.phases에 phase가 없습니다: ${phaseId}`);
  }

  return found;
}

function markPhaseRunning(phaseState: RunStatePhase): void {
  const now = new Date().toISOString();

  phaseState.status = 'running';
  phaseState.startedAt = phaseState.startedAt ?? now;
  phaseState.updatedAt = now;
  phaseState.error = undefined;
}

function markPhaseCompleted(phaseState: RunStatePhase): void {
  phaseState.status = 'completed';
  phaseState.updatedAt = new Date().toISOString();
  phaseState.error = undefined;
}

function markPhaseFailed(phaseState: RunStatePhase, errorMessage: string): void {
  phaseState.status = 'failed';
  phaseState.updatedAt = new Date().toISOString();
  phaseState.error = errorMessage;
}

function addArtifactToState(state: RunState, phaseId: string, relativePath: string): void {
  const phaseArtifacts = state.artifacts[phaseId] ?? [];
  phaseArtifacts.push(relativePath);
  state.artifacts[phaseId] = phaseArtifacts;

  const phaseState = findPhaseState(state, phaseId);
  const existing = phaseState.artifacts ?? [];
  existing.push(relativePath);
  phaseState.artifacts = existing;
}

async function persistState(store: StateStore, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await store.save(state);
}

interface GatekeeperAfterPatchInput {
  gatekeeper: Gatekeeper;
  workflowName: string;
  phase: LlmWorkflowPhase;
  request: string;
  iteration: number;
  state: RunState;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  logger: RunLogger;
  approvalHandler: ApprovalHandler;
  checkCommandIds: string[];
  maxAutoFixRetries: number;
  fixPhaseId?: string;
  evaluatePhaseId?: string;
}

interface GatekeeperAfterPatchResult {
  artifacts: ArtifactRecord[];
  cancelRun: boolean;
  nextPhaseId?: string;
  evaluatorFeedback?: string;
}

async function handleGatekeeperAfterPatch(
  input: GatekeeperAfterPatchInput
): Promise<GatekeeperAfterPatchResult> {
  const records: ArtifactRecord[] = [];
  const risk = await input.gatekeeper.inspectChanges();

  const riskRecord = await input.artifactStore.write({
    phase: input.phase.id,
    name: `${formatIteration(input.iteration)}.gatekeeper-risk.json`,
    content: JSON.stringify(risk, null, 2)
  });
  records.push(riskRecord);

  await input.logger.append(
    { source: 'gatekeeper', phase: input.phase.id },
    {
      message: risk.requiresApproval ? '변경 위험 감지' : '변경 위험 없음',
      context: {
        requiresApproval: risk.requiresApproval,
        reasons: risk.reasons,
        changedFileCount: risk.changedFileCount,
        totalChangedLines: risk.totalChangedLines
      }
    }
  );

  if (risk.requiresApproval) {
    const approvalPrompt = createGatekeeperPrompt(risk);
    input.state.status = 'awaiting_approval';
    input.state.current_phase = input.phase.id;
    await persistState(input.stateStore, input.state);

    const approved = await input.approvalHandler({
      workflowName: input.workflowName,
      phaseId: input.phase.id,
      prompt: approvalPrompt,
      request: input.request,
      iteration: input.iteration
    });

    const approvalRecord = await input.artifactStore.write({
      phase: input.phase.id,
      name: `${formatIteration(input.iteration)}.gatekeeper-approval.txt`,
      content: [
        `[gatekeeper] prompt: ${approvalPrompt}`,
        `[gatekeeper] approved: ${approved ? 'yes' : 'no'}`
      ].join('\n')
    });
    records.push(approvalRecord);

    await input.logger.append(
      { source: 'gatekeeper', phase: input.phase.id },
      {
        message: '게이트키퍼 승인 결과',
        context: {
          approved,
          reasons: risk.reasons
        }
      }
    );

    if (!approved) {
      return {
        artifacts: records,
        cancelRun: true
      };
    }

    input.state.status = 'running';
    input.state.current_phase = input.phase.id;
    await persistState(input.stateStore, input.state);
  }

  if (input.checkCommandIds.length === 0) {
    return {
      artifacts: records,
      cancelRun: false
    };
  }

  const checkResults = await input.gatekeeper.runChecks(input.checkCommandIds);

  for (const result of checkResults) {
    const checkRecord = await input.artifactStore.write({
      phase: input.phase.id,
      name: `${formatIteration(input.iteration)}.check-${normalizeArtifactSuffix(result.commandId)}.txt`,
      content: formatCheckResult(result)
    });
    records.push(checkRecord);
  }

  const checkDecision = input.gatekeeper.decideCheckFailure({
    checkResults,
    retryCount: input.state.retries,
    maxAutoFixRetries: input.maxAutoFixRetries
  });

  await input.logger.append(
    { source: 'gatekeeper', phase: input.phase.id },
    {
      message: '검증 결과 판정',
      context: {
        action: checkDecision.action,
        failedCommandIds: checkDecision.failedCommandIds,
        retries: input.state.retries,
        maxAutoFixRetries: input.maxAutoFixRetries
      }
    }
  );

  if (checkDecision.action === 'pass') {
    return {
      artifacts: records,
      cancelRun: false
    };
  }

  if (checkDecision.action === 'auto_fix') {
    input.state.retries += 1;
    await persistState(input.stateStore, input.state);

    return {
      artifacts: records,
      cancelRun: false,
      nextPhaseId: input.fixPhaseId ?? input.phase.id,
      evaluatorFeedback: createAutoFixFeedback(checkResults, input.state.retries, input.evaluatePhaseId)
    };
  }

  throw new Error(checkDecision.message);
}

interface PatchFirstPhaseInput {
  phase: LlmWorkflowPhase;
  iteration: number;
  outputText: string;
  workspaceDir: string;
  artifactStore: ArtifactStore;
  logger: RunLogger;
}

interface PlannerPhaseArtifactInput {
  phase: LlmWorkflowPhase;
  iteration: number;
  outputText: string;
  artifactStore: ArtifactStore;
}

async function processPlannerPhaseArtifacts(
  input: PlannerPhaseArtifactInput
): Promise<ArtifactRecord[]> {
  if (!isPlanPhase(input.phase)) {
    return [];
  }

  const content = input.outputText.endsWith('\n') ? input.outputText : `${input.outputText}\n`;
  const planRecord = await input.artifactStore.write({
    phase: input.phase.id,
    name: `${formatIteration(input.iteration)}.plan.md`,
    content
  });

  return [planRecord];
}

async function processPatchFirstPhase(input: PatchFirstPhaseInput): Promise<ArtifactRecord[]> {
  if (!isPatchFirstRole(input.phase.role)) {
    return [];
  }

  try {
    const extractedPatch = extractPatchFromText(input.outputText);

    await input.logger.append(
      { source: 'orchestrator', phase: input.phase.id },
      {
        message: 'patch 추출 완료',
        context: {
          source: extractedPatch.source
        }
      }
    );

    const patchRecord = await input.artifactStore.write({
      phase: input.phase.id,
      name: `${formatIteration(input.iteration)}.patch`,
      content: extractedPatch.patch
    });

    await applyPatchToWorkspace({
      workspaceDir: input.workspaceDir,
      patch: extractedPatch.patch
    });

    await input.logger.append(
      { source: 'orchestrator', phase: input.phase.id },
      {
        message: 'patch 적용 완료'
      }
    );

    const capturedDiff = await captureWorkingTreeDiff({
      workspaceDir: input.workspaceDir
    });
    const diffStatRecord = await input.artifactStore.write({
      phase: input.phase.id,
      name: `${formatIteration(input.iteration)}.diffstat.txt`,
      content: capturedDiff.diffStat
    });
    const diffRecord = await input.artifactStore.write({
      phase: input.phase.id,
      name: `${formatIteration(input.iteration)}.diff.txt`,
      content: capturedDiff.diff
    });

    await input.logger.append(
      { source: 'orchestrator', phase: input.phase.id },
      {
        message: 'diff artifacts 저장 완료',
        context: {
          diffStatBytes: diffStatRecord.bytes,
          diffBytes: diffRecord.bytes
        }
      }
    );

    return [patchRecord, diffStatRecord, diffRecord];
  } catch (error) {
    const reason =
      error instanceof PatchApplyError || error instanceof PatchExtractionError ? error.reason : 'unknown';
    const message = toErrorMessage(error);

    await input.logger.append(
      { source: 'orchestrator', phase: input.phase.id },
      {
        level: 'ERROR',
        message: 'patch-first 처리 실패',
        context: {
          reason,
          error: message
        }
      }
    );

    throw error;
  }
}

function createGatekeeperPrompt(risk: {
  reasons: string[];
  changedFileCount: number;
  totalChangedLines: number;
}): string {
  const reasonText = risk.reasons.map((reason) => `- ${reason}`).join('\n');

  return [
    '[Gatekeeper] 위험 변경이 감지되었습니다.',
    `변경 파일 수: ${risk.changedFileCount}`,
    `변경 라인 수: ${risk.totalChangedLines}`,
    '사유:',
    reasonText || '- 없음',
    '계속 진행할까요?'
  ].join('\n');
}

function createAutoFixFeedback(
  checkResults: CommandExecutionResult[],
  retryCount: number,
  evaluatePhaseId?: string
): string {
  const failedResults = checkResults.filter((result) => result.timedOut || result.exitCode !== 0);
  const targetPhaseLabel = evaluatePhaseId ? `phase.${evaluatePhaseId}.output` : '평가 phase';
  const lines = failedResults.map((result) => {
    return [
      `- ${result.commandId}`,
      `  exitCode: ${result.exitCode ?? 'null'}`,
      `  timedOut: ${result.timedOut ? 'yes' : 'no'}`,
      `  stderr: ${truncateForFeedback(result.stderr)}`
    ].join('\n');
  });

  return [
    `[AUTO_FIX] 검증 실패로 fix 재시도(${retryCount}회)`,
    `${targetPhaseLabel}에 사용할 실패 요약`,
    ...lines
  ].join('\n');
}

function formatCheckResult(result: CommandExecutionResult): string {
  return [
    `command_id: ${result.commandId}`,
    `command: ${result.command.join(' ')}`,
    `exit_code: ${result.exitCode ?? 'null'}`,
    `timed_out: ${result.timedOut ? 'yes' : 'no'}`,
    `duration_ms: ${result.durationMs}`,
    '',
    '[stdout]',
    result.stdout,
    '',
    '[stderr]',
    result.stderr
  ].join('\n');
}

function normalizeArtifactSuffix(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9_-]+/g, '-');
  return normalized || 'command';
}

function truncateForFeedback(value: string, limit = 320): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '(empty)';
  }

  if (trimmed.length <= limit) {
    return trimmed;
  }

  return `${trimmed.slice(0, limit)}...[truncated]`;
}

function formatIteration(iteration: number): string {
  return `iter-${String(iteration).padStart(4, '0')}`;
}

function isPatchFirstRole(role: string): boolean {
  return PATCH_FIRST_ROLES.has(role.trim().toLowerCase());
}

function isManagerRole(role: string): boolean {
  return role.trim().toLowerCase() === 'manager';
}

function formatManagerUserUpdate(outputText: string): string {
  const normalized = outputText.trim();

  if (isManagerUserUpdateFormat(normalized)) {
    return normalized;
  }

  const fallback = normalized || '요청된 작업에 대한 사용자 안내입니다.';
  const tldr = fallback
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '요약 없음';

  return [
    '# USER_UPDATE',
    '## TL;DR',
    tldr,
    '',
    '## What changed',
    fallback,
    '',
    '## Risks',
    '- 특이한 리스크 없음',
    '',
    '## Actions needed (Y/n 또는 선택지)',
    '- Y',
    '',
    '## Next',
    '- 다음 단계 진행'
  ].join('\n');
}

function isManagerUserUpdateFormat(outputText: string): boolean {
  return (
    /^#\s*USER_UPDATE\b/im.test(outputText) &&
    /^##\s*TL;DR\b/im.test(outputText) &&
    /^##\s*What changed\b/im.test(outputText) &&
    /^##\s*Risks\b/im.test(outputText) &&
    /^##\s*Actions needed\b/im.test(outputText) &&
    /^##\s*Next\b/im.test(outputText)
  );
}

function isPlanPhase(phase: LlmWorkflowPhase): boolean {
  return phase.id.trim().toLowerCase() === 'plan' && phase.role.trim().toLowerCase() === 'planner';
}

function resolveProviderFromRole(
  roleProviderMap: Record<string, string> | undefined,
  role: string
): string | undefined {
  if (!roleProviderMap) {
    return undefined;
  }

  const providerId = roleProviderMap[role.trim().toLowerCase()];
  return providerId?.trim();
}

function findPhaseIdByRole(phases: WorkflowPhase[], role: string): string | undefined {
  for (const phase of phases) {
    if (phase.type !== 'llm') {
      continue;
    }

    if (phase.role.trim().toLowerCase() === role) {
      return phase.id;
    }
  }

  return undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultApprovalHandler(input: ApprovalRequest): Promise<boolean> {
  void input;
  return true;
}

function normalizeAutoFixRetryCount(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_AUTO_FIX_RETRIES;
  }

  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`maxAutoFixRetries는 0~10 정수여야 합니다: ${value}`);
  }

  return value;
}
