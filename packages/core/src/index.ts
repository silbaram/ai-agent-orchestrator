export interface EmptyArtifact {
  content: string;
}

export function createEmptyArtifact(): EmptyArtifact {
  return { content: '' };
}

export type ProviderSystemPromptMode = 'separate' | 'inline';

export interface ProviderCapabilities {
  systemPromptMode: ProviderSystemPromptMode;
  supportsPatchOutput: boolean;
}

export interface ProviderRunInput {
  systemPrompt: string;
  userPrompt: string;
  workspaceDir: string;
  timeoutMs?: number;
}

export interface ProviderRunMeta {
  durationMs: number;
  stdout: string;
  stderr: string;
  command: string[];
  exitCode?: number | null;
  timedOut?: boolean;
}

export interface ProviderRunOutput {
  text: string;
  meta: ProviderRunMeta;
}

export interface Provider {
  id: string;
  capabilities: ProviderCapabilities;
  run(input: ProviderRunInput): Promise<ProviderRunOutput>;
}

export type ProviderErrorCode = 'TIMEOUT' | 'EXECUTION_FAILED' | 'SPAWN_FAILED' | 'UNKNOWN';

export interface ProviderErrorContext {
  code: ProviderErrorCode;
  meta?: ProviderRunMeta;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly meta?: ProviderRunMeta;

  constructor(message: string, context: ProviderErrorContext) {
    super(message);
    this.name = 'ProviderError';
    this.code = context.code;
    this.meta = context.meta;
  }
}

export {
  ArtifactStore,
  type ArtifactListOptions,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactStoreOptions,
  type ArtifactWriteInput
} from './artifact-store.ts';
export {
  StateStore,
  createInitialRunState,
  type PhaseStatus,
  type RunState,
  type RunStatePhase,
  type RunStatus,
  type StateStoreOptions,
  type UpdateStateOptions
} from './state-store.ts';
export {
  RunLogger,
  type RunLogEntry,
  type RunLogLevel,
  type RunLoggerOptions,
  type RunLogTarget
} from './run-logger.ts';
export {
  Orchestrator,
  type ApprovalHandler,
  type ApprovalRequest,
  type OrchestratorOptions,
  type OrchestratorRunInput,
  type OrchestratorRunResult,
  type ProviderResolver
} from './orchestrator.ts';
export {
  loadWorkflowFromFile,
  parseWorkflowYaml,
  type ApprovalWorkflowPhase,
  type LlmWorkflowPhase,
  type WorkflowDecision,
  type WorkflowDefinition,
  type WorkflowPhase,
  type WorkflowPhaseType
} from './workflow.ts';
export {
  applyPatchToWorkspace,
  captureWorkingTreeDiff,
  extractPatchFromText,
  PatchApplyError,
  PatchExtractionError,
  type ApplyPatchInput,
  type ApplyPatchResult,
  type CapturedDiff,
  type CaptureDiffInput,
  type ExtractedPatch,
  type PatchApplyFailureReason,
  type PatchExtractionFailureReason,
  type PatchSource
} from './patch-first.ts';
export {
  CommandRunner,
  CommandRunnerError,
  type CommandExecutionResult,
  type CommandRunnerOptions,
  type CommandRunnerRunInput
} from './command-runner.ts';
export {
  Gatekeeper,
  decideCheckFailure,
  evaluateRiskFromDiffOutputs,
  type ChangeRiskDecision,
  type GatekeeperCheckDecision,
  type GatekeeperOptions
} from './gatekeeper.ts';
export {
  parseToolsYaml,
  type AllowedToolCommand,
  type ToolsConfig
} from './tools-config.ts';
