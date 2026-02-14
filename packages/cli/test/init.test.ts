import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCli } from '../src/index.ts';

const EXPECTED_DIRECTORIES = [
  'ai-dev-team',
  'ai-dev-team/artifacts',
  'ai-dev-team/roles',
  'ai-dev-team/rules',
  'ai-dev-team/config',
  'ai-dev-team/config/workflows',
  'ai-dev-team/state'
] as const;

const EXPECTED_FILES = [
  'ai-dev-team/config/routing.yaml',
  'ai-dev-team/config/gatekeeper.yaml',
  'ai-dev-team/config/tools.yaml',
  'ai-dev-team/config/workflows/refactor.yaml'
] as const;

test('aao init은 워크스페이스 구조를 생성하고 중복 생성을 막는다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-init-'));
  const previousWorkingDirectory = process.cwd();
  process.chdir(temporaryDirectory);

  try {
    const cli = createCli();
    await cli.parse(['node', 'aao', 'init']);

    for (const relativePath of EXPECTED_DIRECTORIES) {
      const targetPath = path.join(temporaryDirectory, relativePath);
      const stats = await stat(targetPath);
      assert.equal(stats.isDirectory(), true, `${targetPath}는 디렉토리여야 한다.`);
    }

    for (const relativePath of EXPECTED_FILES) {
      const targetPath = path.join(temporaryDirectory, relativePath);
      const stats = await stat(targetPath);
      assert.equal(stats.isFile(), true, `${targetPath}는 파일이어야 한다.`);
    }

    const workflowTemplate = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/workflows/refactor.yaml'),
      'utf8'
    );
    assert.match(workflowTemplate, /name: refactor/);

    const routingTemplate = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/routing.yaml'),
      'utf8'
    );
    assert.match(routingTemplate, /provider:\s+codex-cli/);

    const toolsTemplate = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/tools.yaml'),
      'utf8'
    );
    assert.match(toolsTemplate, /id:\s+build/);

    await assert.rejects(
      async () => {
        await cli.parse(['node', 'aao', 'init']);
      },
      /이미 존재합니다/
    );
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
