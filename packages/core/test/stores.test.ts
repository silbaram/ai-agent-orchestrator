import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore, createInitialRunState, RunLogger, StateStore } from '../src/index.ts';

test('ArtifactStore는 write/read/list와 index.json 기록을 지원한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-artifacts-'));
  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const store = new ArtifactStore({ runDir });

  await store.write({
    phase: 'plan',
    name: 'iter-0001.md',
    content: '# plan'
  });
  await store.write({
    phase: 'execute',
    name: 'iter-0001.patch',
    content: 'diff --git a/a.txt b/a.txt\n'
  });

  const content = await store.read({ phase: 'plan', name: 'iter-0001.md' });
  assert.equal(content, '# plan');

  const allArtifacts = await store.list();
  assert.equal(allArtifacts.length, 2);

  const executeArtifacts = await store.list({ phase: 'execute' });
  assert.equal(executeArtifacts.length, 1);
  assert.equal(executeArtifacts[0]?.relativePath, 'execute/iter-0001.patch');

  const indexRaw = await readFile(path.join(runDir, 'artifacts', 'index.json'), 'utf8');
  const index = JSON.parse(indexRaw) as { artifacts: Array<{ relativePath: string }> };
  assert.deepEqual(
    index.artifacts.map((artifact) => artifact.relativePath),
    ['execute/iter-0001.patch', 'plan/iter-0001.md']
  );
});

test('StateStore는 save/load/update를 원자적으로 처리한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-state-'));
  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const store = new StateStore({ runDir });
  const initial = createInitialRunState({
    status: 'running',
    current_phase: 'plan',
    phases: [{ id: 'plan', status: 'running' }],
    artifacts: { plan: ['plan/iter-0001.md'] }
  });

  const saved = await store.save(initial);
  const loaded = await store.load();

  assert.equal(saved.status, 'running');
  assert.equal(loaded?.current_phase, 'plan');
  assert.deepEqual(loaded?.artifacts.plan, ['plan/iter-0001.md']);

  const updated = await store.update((state) => ({
    ...state,
    status: 'completed',
    current_phase: null,
    retries: state.retries + 1,
    phases: state.phases.map((phase) =>
      phase.id === 'plan'
        ? {
            ...phase,
            status: 'completed'
          }
        : phase
    ),
    artifacts: {
      ...state.artifacts,
      execute: ['execute/iter-0001.patch']
    }
  }));

  assert.equal(updated.status, 'completed');
  assert.equal(updated.current_phase, null);
  assert.equal(updated.retries, 1);
  assert.deepEqual(updated.artifacts.execute, ['execute/iter-0001.patch']);
  assert.ok(updated.updatedAt >= saved.updatedAt);

  const parentEntries = await readdir(path.dirname(store.stateFilePath));
  assert.equal(parentEntries.some((name) => name.includes('.tmp')), false);
});

test('StateStore update는 파일이 없어도 createIfMissing 옵션으로 초기화할 수 있다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-state-init-'));
  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const store = new StateStore({ runDir });

  const state = await store.update(
    (current) => ({
      ...current,
      status: 'running',
      current_phase: 'plan',
      phases: [{ id: 'plan', status: 'running' }]
    }),
    { createIfMissing: true }
  );

  assert.equal(state.status, 'running');
  assert.equal(state.current_phase, 'plan');
  assert.equal(state.retries, 0);
});

test('RunLogger는 logs/<source>-<phase>.log 경로 규칙으로 로그를 append/read 한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-logger-'));
  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const logger = new RunLogger({ runDir });
  const logPath = logger.resolveLogPath({ source: 'provider', phase: 'plan' });

  assert.equal(path.relative(runDir, logPath), path.join('logs', 'provider-plan.log'));

  await logger.append({ source: 'provider', phase: 'plan' }, 'phase started');
  await logger.append(
    { source: 'provider', phase: 'plan' },
    {
      level: 'ERROR',
      message: 'phase failed',
      context: { reason: 'timeout' }
    }
  );

  const content = await logger.read({ source: 'provider', phase: 'plan' });

  assert.match(content, /\[INFO\] phase started/);
  assert.match(content, /\[ERROR\] phase failed/);
  assert.match(content, /"reason":"timeout"/);
});
