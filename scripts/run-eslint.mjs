#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const eslintBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'eslint.cmd' : 'eslint'
);

const targets = process.argv.slice(2);

if (targets.length === 0) {
  targets.push('packages', 'scripts');
}

if (!(await exists(eslintBin))) {
  console.log('[lint] eslint가 설치되지 않아 lint를 건너뜁니다. (npm/pnpm install 후 활성화)');
  process.exit(0);
}

await run(eslintBin, targets);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`eslint가 종료 코드 ${code}로 실패했습니다.`));
    });

    child.on('error', reject);
  });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
