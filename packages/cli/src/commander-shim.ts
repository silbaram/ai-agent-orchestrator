export type CommandAction = (args: string[]) => void | Promise<void>;

export class Command {
  private commandName = 'command';
  private commandDescription = '';
  private commandVersion = '0.0.0';
  private readonly subcommands: Command[] = [];
  private commandAction?: CommandAction;
  private parent?: Command;

  constructor(name?: string) {
    if (name) {
      this.commandName = name;
    }
  }

  name(name: string): this {
    this.commandName = name;
    return this;
  }

  description(description: string): this {
    this.commandDescription = description;
    return this;
  }

  version(version: string): this {
    this.commandVersion = version;
    return this;
  }

  command(name: string): Command {
    const child = new Command(name);
    child.parent = this;
    this.subcommands.push(child);
    return child;
  }

  action(action: CommandAction): this {
    this.commandAction = action;
    return this;
  }

  async parse(argv: string[]): Promise<void> {
    const args = argv.slice(2);
    await this.execute(args);
  }

  helpInformation(): string {
    const lines = [`Usage: ${this.usagePath()} [command] [options]`];

    if (this.commandDescription) {
      lines.push('', this.commandDescription);
    }

    if (this.subcommands.length > 0) {
      lines.push('', 'Commands:');

      for (const subcommand of this.subcommands) {
        lines.push(`  ${subcommand.commandName.padEnd(14)}${subcommand.commandDescription}`);
      }
    }

    lines.push('', 'Options:', '  -h, --help      help 표시', '  -V, --version   버전 표시');

    return lines.join('\n');
  }

  private async execute(args: string[]): Promise<void> {
    if (args.includes('-V') || args.includes('--version')) {
      console.log(this.commandVersion);
      return;
    }

    if (args.includes('-h') || args.includes('--help')) {
      console.log(this.helpInformation());
      return;
    }

    const [commandName, ...restArgs] = args;

    if (commandName) {
      const subcommand = this.subcommands.find((candidate) => candidate.commandName === commandName);

      if (subcommand) {
        await subcommand.execute(restArgs);
        return;
      }

      if (this.subcommands.length > 0) {
        console.error(`알 수 없는 커맨드: ${commandName}`);
        console.error(this.helpInformation());
        process.exitCode = 1;
        return;
      }
    }

    if (this.commandAction) {
      await this.commandAction(args);
      return;
    }

    console.log(this.helpInformation());
  }

  private usagePath(): string {
    if (!this.parent) {
      return this.commandName;
    }

    return `${this.parent.usagePath()} ${this.commandName}`;
  }
}
