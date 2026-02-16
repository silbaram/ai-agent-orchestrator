import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  'ai-dev-team/config/workflows/feature.yaml',
  'ai-dev-team/config/workflows/refactor.yaml',
  'ai-dev-team/config/workflows/feature-order-page.yaml',
  'ai-dev-team/roles/analyzer.md',
  'ai-dev-team/roles/documenter.md',
  'ai-dev-team/roles/planner.md',
  'ai-dev-team/roles/manager.md',
  'ai-dev-team/roles/developer.md',
  'ai-dev-team/roles/evaluator.md',
  'ai-dev-team/roles/fixer.md',
  'ai-dev-team/roles/improver.md',
  'ai-dev-team/roles/reviewer.md'
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
    assert.match(
      await readFile(
        path.join(temporaryDirectory, 'ai-dev-team/config/workflows/feature-order-page.yaml'),
        'utf8'
      ),
      /name: feature-order-page/
    );
    const plannerPrompt = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/roles/planner.md'),
      'utf8'
    );
    assert.match(plannerPrompt, /Planner/);

    const routingTemplate = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/routing.yaml'),
      'utf8'
    );
    assert.match(routingTemplate, /provider:\s+codex-cli/);
    assert.match(routingTemplate, /manager:\s+gemini/);
    assert.match(routingTemplate, /planner:\s+codex-cli/);
    assert.match(routingTemplate, /developer:\s+claude/);
    assert.match(routingTemplate, /analyzer:\s+codex-cli/);
    assert.match(routingTemplate, /documenter:\s+codex-cli/);
    assert.match(routingTemplate, /improver:\s+codex-cli/);
    assert.match(routingTemplate, /reviewer:\s+codex-cli/);

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

test('aao init은 package.json 환경에서 npm build/test tools.yaml을 생성한다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-init-package-'));
  const previousWorkingDirectory = process.cwd();

  try {
    process.chdir(temporaryDirectory);
    await writeFile(
      path.join(temporaryDirectory, 'package.json'),
      JSON.stringify({ name: 'sample', scripts: { build: 'echo build', test: 'echo test' }), 'utf8'
    );
    await writeFile(path.join(temporaryDirectory, 'package-lock.json'), '{}', 'utf8');

    const cli = createCli();
    await cli.parse(['node', 'aao', 'init']);

    const toolsTemplate = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/tools.yaml'),
      'utf8'
    );

    assert.match(toolsTemplate, /executable:\s+npm/);
    assert.match(toolsTemplate, /- run/);
    assert.match(toolsTemplate, /id:\s+build/);
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('aao init은 Gradle 프로젝트에서 gradle build/test tools.yaml을 생성한다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-init-gradle-'));
  const previousWorkingDirectory = process.cwd();

  try {
    process.chdir(temporaryDirectory);
    await writeFile(path.join(temporaryDirectory, 'gradlew'), '#!/bin/sh\necho gradle', 'utf8');
    await writeFile(path.join(temporaryDirectory, 'build.gradle'), 'plugins {}', 'utf8');

    const cli = createCli();
    await cli.parse(['node', 'aao', 'init']);

    const toolsTemplate = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/tools.yaml'),
      'utf8'
    );
    const expectedGradleExecutable =
      process.platform === 'win32' ? /executable:\s+gradlew\.bat/ : /executable:\s+\.\/gradlew/;

    assert.match(toolsTemplate, expectedGradleExecutable);
    assert.match(toolsTemplate, /id:\s+build/);
    assert.match(toolsTemplate, /id:\s+test/);
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('aao tools detect는 project 감지 기반으로 tools.yaml을 갱신한다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-tools-detect-'));
  const previousWorkingDirectory = process.cwd();

  try {
    process.chdir(temporaryDirectory);
    await writeFile(
      path.join(temporaryDirectory, 'package.json'),
      JSON.stringify({ name: 'sample', scripts: { build: 'echo build', test: 'echo test' }), 'utf8'
    );
    await writeFile(path.join(temporaryDirectory, 'package-lock.json'), '{}', 'utf8');

    const cli = createCli();
    await cli.parse(['node', 'aao', 'init']);

    const toolsTemplateAfterInit = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/tools.yaml'),
      'utf8'
    );
    assert.match(toolsTemplateAfterInit, /executable:\s+npm/);

    await writeFile(path.join(temporaryDirectory, 'yarn.lock'), 'yarn.lock', 'utf8');
    await cli.parse(['node', 'aao', 'tools', 'detect']);

    const toolsTemplateAfterDetect = await readFile(
      path.join(temporaryDirectory, 'ai-dev-team/config/tools.yaml'),
      'utf8'
    );
    assert.match(toolsTemplateAfterDetect, /executable:\s+yarn/);
  } finally {
    process.chdir(previousWorkingDirectory);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
