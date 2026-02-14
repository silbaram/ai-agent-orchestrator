import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type RunStatus =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'canceled';

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface RunStatePhase {
  id: string;
  status: PhaseStatus;
  startedAt?: string;
  updatedAt?: string;
  artifacts?: string[];
  error?: string;
}

export interface RunState {
  status: RunStatus;
  current_phase: string | null;
  phases: RunStatePhase[];
  retries: number;
  startedAt: string;
  updatedAt: string;
  artifacts: Record<string, string[]>;
}

export interface StateStoreOptions {
  runDir: string;
  fileName?: string;
}

export interface UpdateStateOptions {
  createIfMissing?: boolean;
  initialState?: RunState;
}

type StateUpdater = (state: RunState) => RunState | Promise<RunState>;

export class StateStore {
  readonly stateFilePath: string;

  constructor(options: StateStoreOptions) {
    this.stateFilePath = path.resolve(options.runDir, options.fileName ?? 'current-run.json');
  }

  async load(): Promise<RunState | null> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as RunState;
      return normalizeRunState(parsed, { touchUpdatedAt: false });
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  async save(state: RunState): Promise<RunState> {
    const next = normalizeRunState(state, { touchUpdatedAt: false });
    await writeJsonAtomically(this.stateFilePath, next);
    return next;
  }

  async update(updater: StateUpdater, options: UpdateStateOptions = {}): Promise<RunState> {
    const current = (await this.load()) ?? this.createMissingState(options);
    const next = await updater(cloneRunState(current));
    const normalized = normalizeRunState(next, { touchUpdatedAt: true, fallbackStartedAt: current.startedAt });

    await writeJsonAtomically(this.stateFilePath, normalized);
    return normalized;
  }

  private createMissingState(options: UpdateStateOptions): RunState {
    if (!options.createIfMissing) {
      throw new Error(`상태 파일이 없습니다: ${this.stateFilePath}`);
    }

    return options.initialState ? normalizeRunState(options.initialState, { touchUpdatedAt: false }) : createInitialRunState();
  }
}

export function createInitialRunState(seed: Partial<RunState> = {}): RunState {
  const now = seed.startedAt ?? new Date().toISOString();

  return normalizeRunState(
    {
      status: seed.status ?? 'created',
      current_phase: seed.current_phase ?? null,
      phases: seed.phases ?? [],
      retries: seed.retries ?? 0,
      startedAt: seed.startedAt ?? now,
      updatedAt: seed.updatedAt ?? now,
      artifacts: seed.artifacts ?? {}
    },
    { touchUpdatedAt: false }
  );
}

interface NormalizeOptions {
  touchUpdatedAt: boolean;
  fallbackStartedAt?: string;
}

function normalizeRunState(state: RunState, options: NormalizeOptions): RunState {
  const startedAt = state.startedAt || options.fallbackStartedAt || new Date().toISOString();
  const updatedAt = options.touchUpdatedAt ? new Date().toISOString() : state.updatedAt || startedAt;

  const normalized: RunState = {
    status: state.status,
    current_phase: state.current_phase ?? null,
    phases: state.phases.map((phase) => ({
      id: phase.id,
      status: phase.status,
      startedAt: phase.startedAt,
      updatedAt: phase.updatedAt,
      artifacts: phase.artifacts ? [...phase.artifacts] : undefined,
      error: phase.error
    })),
    retries: state.retries,
    startedAt,
    updatedAt,
    artifacts: Object.fromEntries(
      Object.entries(state.artifacts).map(([phase, artifacts]) => [phase, [...artifacts]])
    )
  };

  assertValidRunState(normalized);
  return normalized;
}

function assertValidRunState(state: RunState): void {
  if (!state.status) {
    throw new Error('state.status는 필수입니다.');
  }

  if (!Array.isArray(state.phases)) {
    throw new Error('state.phases는 배열이어야 합니다.');
  }

  if (!Number.isInteger(state.retries) || state.retries < 0) {
    throw new Error('state.retries는 0 이상의 정수여야 합니다.');
  }

  if (typeof state.startedAt !== 'string' || state.startedAt.length === 0) {
    throw new Error('state.startedAt은 필수 ISO 문자열이어야 합니다.');
  }

  if (typeof state.updatedAt !== 'string' || state.updatedAt.length === 0) {
    throw new Error('state.updatedAt은 필수 ISO 문자열이어야 합니다.');
  }

  if (state.current_phase !== null && typeof state.current_phase !== 'string') {
    throw new Error('state.current_phase는 문자열 또는 null이어야 합니다.');
  }

  if (typeof state.artifacts !== 'object' || state.artifacts === null) {
    throw new Error('state.artifacts는 map 객체여야 합니다.');
  }

  for (const phase of state.phases) {
    if (!phase.id) {
      throw new Error('state.phases[].id는 필수입니다.');
    }

    if (!phase.status) {
      throw new Error('state.phases[].status는 필수입니다.');
    }
  }

  for (const [phase, artifacts] of Object.entries(state.artifacts)) {
    if (!phase) {
      throw new Error('state.artifacts의 key는 비어 있을 수 없습니다.');
    }

    if (!Array.isArray(artifacts) || artifacts.some((artifact) => typeof artifact !== 'string')) {
      throw new Error('state.artifacts의 값은 문자열 배열이어야 합니다.');
    }
  }
}

function cloneRunState(state: RunState): RunState {
  return JSON.parse(JSON.stringify(state)) as RunState;
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempFilePath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );

  await mkdir(directory, { recursive: true });
  await writeFile(tempFilePath, JSON.stringify(data, null, 2), 'utf8');

  try {
    await rename(tempFilePath, filePath);
  } catch (error) {
    await rm(tempFilePath, { force: true });
    throw error;
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
