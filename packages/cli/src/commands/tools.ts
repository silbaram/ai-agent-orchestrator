import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { Command } from '../commander-shim.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  regenerateToolsYaml
} from '../workspace/init-workspace.ts';

export function registerToolsCommand(program: Command): void {
  const tools = program.command('tools').description('도구 설정을 관리합니다.');

  tools
    .command('detect')
    .description('현재 프로젝트 유형에 맞게 tools.yaml을 재생성합니다.')
    .action(async () => {
      const cwd = process.cwd();
      const workspacePath = path.resolve(cwd, DEFAULT_WORKSPACE_NAME);
      await ensureWorkspaceExists(workspacePath);

      const result = await regenerateToolsYaml(workspacePath, cwd);
      console.log(`tools.yaml 갱신: ${result.toolsYamlPath}`);
    });
}

async function ensureWorkspaceExists(workspacePath: string): Promise<void> {
  try {
    await access(workspacePath, constants.F_OK);
  } catch {
    throw new Error(`워크스페이스가 없습니다: ${workspacePath} (먼저 init 실행 필요)`);
  }
}
