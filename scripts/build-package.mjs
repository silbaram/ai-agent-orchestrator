#!/usr/bin/env node

import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const packageArg = process.argv[2];

if (!packageArg) {
  console.error('[build] 패키지 경로를 전달해야 합니다. 예: packages/core');
  process.exit(1);
}

const packageDir = path.resolve(repoRoot, packageArg);
const srcDir = path.join(packageDir, 'src');
const distDir = path.join(packageDir, 'dist');

const files = await collectTypeScriptFiles(srcDir);

if (files.length === 0) {
  console.error(`[build] ${packageArg}에 src/*.ts 파일이 없습니다.`);
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const transformed = stripTypeScriptTypes(source, { mode: 'transform' });
  const rewrittenImports = transformed
    .replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2')
    .replace(/(import\(\s*['"][^'"]+)\.ts(['"]\s*\))/g, '$1.js$2');

  const relativePath = path.relative(srcDir, file);
  const outputPath = path.join(distDir, relativePath.replace(/\.ts$/, '.js'));

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rewrittenImports, 'utf8');

  if (rewrittenImports.startsWith('#!')) {
    await chmod(outputPath, 0o755);
  }
}

console.log(`[build] ${packageArg} -> dist (${files.length}개 파일)`);

async function collectTypeScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const tsFiles = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      tsFiles.push(...(await collectTypeScriptFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      tsFiles.push(fullPath);
    }
  }

  return tsFiles;
}
