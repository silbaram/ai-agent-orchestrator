import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ArtifactStoreOptions {
  runDir: string;
  artifactsDirName?: string;
  enableIndex?: boolean;
  indexFileName?: string;
}

export interface ArtifactRef {
  phase: string;
  name: string;
}

export interface ArtifactWriteInput extends ArtifactRef {
  content: string | Uint8Array;
}

export interface ArtifactRecord extends ArtifactRef {
  relativePath: string;
  bytes: number;
  updatedAt: string;
}

export interface ArtifactListOptions {
  phase?: string;
}

interface ArtifactIndexFile {
  artifacts: ArtifactRecord[];
  updatedAt: string;
}

export class ArtifactStore {
  readonly artifactsDir: string;
  readonly indexFilePath: string;

  private readonly enableIndex: boolean;

  constructor(options: ArtifactStoreOptions) {
    this.artifactsDir = path.resolve(options.runDir, options.artifactsDirName ?? 'artifacts');
    this.enableIndex = options.enableIndex ?? true;
    this.indexFilePath = path.resolve(this.artifactsDir, options.indexFileName ?? 'index.json');
  }

  async write(input: ArtifactWriteInput): Promise<ArtifactRecord> {
    const { absolutePath, relativePath, phase, name } = this.resolveArtifactPath(input);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content);

    const fileStat = await stat(absolutePath);
    const record: ArtifactRecord = {
      phase,
      name,
      relativePath,
      bytes: fileStat.size,
      updatedAt: new Date(fileStat.mtimeMs).toISOString()
    };

    if (this.enableIndex) {
      await this.updateIndex(record);
    }

    return record;
  }

  async read(ref: ArtifactRef): Promise<string> {
    const { absolutePath } = this.resolveArtifactPath(ref);
    return readFile(absolutePath, 'utf8');
  }

  async list(options: ArtifactListOptions = {}): Promise<ArtifactRecord[]> {
    const phaseFilter = options.phase ? normalizePhase(options.phase) : null;
    const records = this.enableIndex
      ? ((await this.readIndexIfExists()) ?? (await this.scanArtifacts()))
      : await this.scanArtifacts();

    const filtered = phaseFilter
      ? records.filter((record) => record.phase === phaseFilter)
      : records.slice();

    return filtered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private resolveArtifactPath(ref: ArtifactRef): {
    absolutePath: string;
    relativePath: string;
    phase: string;
    name: string;
  } {
    const phase = normalizePhase(ref.phase);
    const name = normalizeRelativePath(ref.name, 'name');

    const absolutePath = path.resolve(this.artifactsDir, phase, name);
    ensurePathWithinRoot(this.artifactsDir, absolutePath, 'artifact path');

    const relativePath = toPosix(path.relative(this.artifactsDir, absolutePath));

    return {
      absolutePath,
      relativePath,
      phase,
      name
    };
  }

  private async scanArtifacts(): Promise<ArtifactRecord[]> {
    const files = await collectFiles(this.artifactsDir);
    const records: ArtifactRecord[] = [];

    for (const filePath of files) {
      if (path.resolve(filePath) === this.indexFilePath) {
        continue;
      }

      const relativePath = toPosix(path.relative(this.artifactsDir, filePath));
      const [phase, ...nameParts] = relativePath.split('/');
      if (!phase || nameParts.length === 0) {
        continue;
      }

      const fileStat = await stat(filePath);

      records.push({
        phase,
        name: nameParts.join('/'),
        relativePath,
        bytes: fileStat.size,
        updatedAt: new Date(fileStat.mtimeMs).toISOString()
      });
    }

    return records;
  }

  private async updateIndex(record: ArtifactRecord): Promise<void> {
    const current = (await this.readIndexIfExists()) ?? [];
    const byPath = new Map<string, ArtifactRecord>(current.map((item) => [item.relativePath, item]));
    byPath.set(record.relativePath, record);

    const next: ArtifactIndexFile = {
      artifacts: Array.from(byPath.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      updatedAt: new Date().toISOString()
    };

    await writeJsonAtomically(this.indexFilePath, next);
  }

  private async readIndexIfExists(): Promise<ArtifactRecord[] | null> {
    try {
      const raw = await readFile(this.indexFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ArtifactIndexFile> | ArtifactRecord[];

      if (Array.isArray(parsed)) {
        return parsed.map(cloneArtifactRecord);
      }

      if (Array.isArray(parsed.artifacts)) {
        return parsed.artifacts.map(cloneArtifactRecord);
      }

      throw new Error('index.json 형식이 올바르지 않습니다.');
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }
}

function cloneArtifactRecord(record: ArtifactRecord): ArtifactRecord {
  return {
    phase: record.phase,
    name: record.name,
    relativePath: record.relativePath,
    bytes: record.bytes,
    updatedAt: record.updatedAt
  };
}

async function collectFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await collectFiles(fullPath)));
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

function normalizeRelativePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label}는 비어 있을 수 없습니다.`);
  }

  const normalized = path.posix.normalize(trimmed.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label}는 상대 경로여야 합니다: ${value}`);
  }

  return normalized;
}

function normalizePhase(value: string): string {
  const normalized = normalizeRelativePath(value, 'phase');
  if (normalized.includes('/')) {
    throw new Error(`phase는 단일 세그먼트여야 합니다: ${value}`);
  }

  return normalized;
}

function ensurePathWithinRoot(rootDir: string, candidatePath: string, label: string): void {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`${label}가 root 범위를 벗어났습니다: ${candidatePath}`);
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
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
