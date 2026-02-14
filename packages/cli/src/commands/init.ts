import { Command } from '../commander-shim.ts';
import { initWorkspace } from '../workspace/init-workspace.ts';

interface InitCommandOptions {
  force: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('현재 디렉토리에 ai-dev-team 워크스페이스를 생성한다.')
    .action(async (args) => {
      const options = parseInitArgs(args);
      const result = await initWorkspace({ force: options.force });
      console.log(`워크스페이스 생성 완료: ${result.workspacePath}`);
    });
}

function parseInitArgs(args: string[]): InitCommandOptions {
  const options: InitCommandOptions = { force: false };

  for (const arg of args) {
    if (arg === '--force') {
      options.force = true;
      continue;
    }

    throw new Error(`지원하지 않는 옵션입니다: ${arg}`);
  }

  return options;
}
