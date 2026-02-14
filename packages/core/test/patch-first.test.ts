import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyPatchToWorkspace,
  captureWorkingTreeDiff,
  extractPatchFromText,
  PatchApplyError
} from '../src/index.ts';

test('patch-first는 diff 코드블록에서 patch를 추출해 적용하고 diff를 캡처한다.', async (t) => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'adt-patch-first-success-'));
  const targetFile = path.join(repoDir, 'hello.txt');

  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  runGit(repoDir, ['init']);
  await writeFile(targetFile, 'before\n', 'utf8');
  runGit(repoDir, ['add', 'hello.txt']);

  const responseText = [
    '변경 내용입니다.',
    '```diff',
    'diff --git a/hello.txt b/hello.txt',
    '--- a/hello.txt',
    '+++ b/hello.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '```'
  ].join('\n');

  const extracted = extractPatchFromText(responseText);
  assert.equal(extracted.source, 'diff_code_block');

  await applyPatchToWorkspace({
    workspaceDir: repoDir,
    patch: extracted.patch
  });

  const nextContent = await readFile(targetFile, 'utf8');
  assert.equal(nextContent, 'after\n');

  const diff = await captureWorkingTreeDiff({ workspaceDir: repoDir });
  assert.match(diff.diffStat, /hello\.txt/);
  assert.match(diff.diff, /\+after/);
});

test('patch-first는 컨텍스트가 맞지 않는 patch 적용 실패 이유를 리포트한다.', async (t) => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'adt-patch-first-failure-'));
  const targetFile = path.join(repoDir, 'hello.txt');

  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  runGit(repoDir, ['init']);
  await writeFile(targetFile, 'before\n', 'utf8');
  runGit(repoDir, ['add', 'hello.txt']);

  const responseText = [
    '### PATCH',
    'diff --git a/hello.txt b/hello.txt',
    '--- a/hello.txt',
    '+++ b/hello.txt',
    '@@ -1 +1 @@',
    '-not-found',
    '+after'
  ].join('\n');

  const extracted = extractPatchFromText(responseText);
  assert.equal(extracted.source, 'patch_section');

  await assert.rejects(
    async () =>
      applyPatchToWorkspace({
        workspaceDir: repoDir,
        patch: extracted.patch
      }),
    (error: unknown) => {
      assert.ok(error instanceof PatchApplyError);
      assert.equal(error.reason, 'context_mismatch');
      assert.match(error.message, /컨텍스트 불일치/);
      return true;
    }
  );
});

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe'
  });
}
