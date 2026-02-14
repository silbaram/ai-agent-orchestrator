#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const prettierBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier'
);

const args = process.argv.slice(2);

if (args.length === 0) {
  args.push('--check', '.');
}

if (!(await exists(prettierBin))) {
  console.log('[format] prettier가 설치되지 않아 format을 건너뜁니다. (npm/pnpm install 후 활성화)');
  process.exit(0);
}

await run(prettierBin, args);

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`prettier가 종료 코드 ${code}로 실패했습니다.`));
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
