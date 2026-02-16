#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from './commander-shim.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerManagerCommand, type ManagerCommandDependencies } from './commands/manager.ts';
import { registerToolsCommand } from './commands/tools.ts';

export interface CliDependencies {
  manager?: ManagerCommandDependencies;
}

export function createCli(dependencies: CliDependencies = {}): Command {
  const program = new Command();

  program
    .name('aao')
    .description('ai-agent-orchestrator CLI')
    .version('0.1.0');

  registerInitCommand(program);
  registerManagerCommand(program, dependencies.manager);
  registerToolsCommand(program);

  program
    .command('run')
    .description('워크플로 실행 (다음 Phase에서 구현)')
    .action(() => {
      console.log('run 커맨드는 다음 Phase에서 구현됩니다.');
    });

  return program;
}

async function main(): Promise<void> {
  const cli = createCli();
  await cli.parse(process.argv);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (currentFilePath === invokedFilePath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

export {
  runManagerRefactor,
  type ManagerRefactorResult,
  type ManagerRunCreatedEvent
} from './commands/manager.ts';
