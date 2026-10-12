import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const SCRIPT_TEMPLATE = `# Daily rewards
ncell game check-in
ncell game claim-task 1,2,3,4,5,6,7,8

# Spinner reward
ncell game spin --count 5
ncell game claim-task 22

# Scratch card reward
ncell game scratch --count 4
ncell game claim-task 23

# Math reward
ncell game math --count 1
ncell game claim-task 26

# Game Warrior reward
ncell game claim-task 18

# Math Genius reward
ncell game math --count 4
ncell game claim-task 24

# Spend remaining tokens
ncell game spin --count all

# Final checks
ncell game status
ncell game ranks
`;

export function scriptDirectory(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
          ? process.env.XDG_DATA_HOME
          : join(homedir(), '.local', 'share');
  return join(base, 'ncell-cli', 'scripts');
}

function scriptName(name: string): string {
  if (basename(name) !== name || /[/\\:\0]/.test(name) || !/^.+\.ncell$/i.test(name)) {
    throw new Error('Use a script name ending in .ncell, such as daily.ncell');
  }
  return name;
}

export async function openEditor(file: string): Promise<void> {
  const [command, args] =
    process.platform === 'win32'
      ? (['notepad.exe', [file]] as const)
      : process.platform === 'darwin'
        ? (['open', ['-t', file]] as const)
        : (['xdg-open', [file]] as const);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ['inherit', 'ignore', 'inherit'],
    });
    child.once('error', () =>
      reject(new Error(`Script is saved at ${file}, but the text editor could not open`)),
    );
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Editor exited unsuccessfully. Script remains saved at ${file}`)),
    );
  });
}

export class ScriptLibrary {
  constructor(
    readonly directory = scriptDirectory(),
    readonly editor = openEditor,
  ) {}

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.ncell$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async create(name: string): Promise<string> {
    scriptName(name);
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, name);
    await writeFile(file, SCRIPT_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    await this.editor(file);
    return file;
  }

  async edit(name: string): Promise<void> {
    const file = join(this.directory, scriptName(name));
    if (!(await lstat(file)).isFile()) throw new Error('The saved script is not a file');
    await this.editor(file);
  }

  async delete(name: string): Promise<void> {
    await unlink(join(this.directory, scriptName(name)));
  }

  async resolve(name: string, cwd = process.cwd()): Promise<string> {
    if (basename(name) === name && !/[/\\:\0]/.test(name) && /^.+\.ncell$/i.test(name)) {
      try {
        const file = join(this.directory, name);
        await access(file);
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return resolve(cwd, name);
  }

  async read(name: string, cwd?: string): Promise<string> {
    const bytes = await readFile(await this.resolve(name, cwd));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}

/** Shell-free tokens. Backslashes remain literal, including in Windows paths. */
export function tokenize(line: string): string[] {
  const words: string[] = [];
  let word = '',
    quote = '',
    started = false;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if ('|&;<>`$'.includes(character)) {
      throw new Error('Shell operators and substitutions are not supported');
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote');
  if (started) words.push(word);
  return words;
}

export interface ScriptStep<T> {
  line: number;
  command: string;
  parsed: T;
}
export class ScriptExecutionError extends Error {
  constructor(
    readonly step: number,
    readonly total: number,
    readonly line: number,
    cause: unknown,
  ) {
    super(
      `Step ${step} of ${total} (line ${line}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'ScriptExecutionError';
  }
}
export function parseScript<T>(source: string, validate: (argv: string[]) => T): ScriptStep<T>[] {
  const steps: ScriptStep<T>[] = [];
  for (const [index, sourceLine] of source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const command = sourceLine.trim();
    if (!command || command.startsWith('#')) continue;
    try {
      const argv = tokenize(command);
      if (argv[0] === 'ncell') argv.shift();
      if (argv[0] === 'script') throw new Error('Nested script commands are not supported');
      steps.push({ line: index + 1, command, parsed: validate(argv) });
    } catch (error) {
      throw new Error(`Line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return steps;
}

export async function executeScript<T>(
  steps: ScriptStep<T>[],
  execute: (step: ScriptStep<T>, index: number, total: number) => Promise<void>,
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    try {
      await execute(step, index + 1, steps.length);
    } catch (error) {
      throw new ScriptExecutionError(index + 1, steps.length, step.line, error);
    }
  }
}
