import { DEFAULT_PLAN_CATEGORY } from '../core/catalog.js';
import { Command, InvalidArgumentError } from 'commander';
import { createRequire } from 'node:module';
import { parseCount, parseDelay } from '../app.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
export const SORT_FIELDS = ['price', 'validity'] as const;

export interface ParsedCommand {
  command: string;
  args: string[];
  json: boolean;
  verify?: boolean;
  count?: number | 'all';
  delay?: number;
  category?: number;
  sort?: string;
  yes?: boolean;
  dryRun?: boolean;
}

function positive(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new InvalidArgumentError('Use a positive integer');
  }
  return number;
}

function sortFields(value: string): string {
  const field = `(${SORT_FIELDS.join('|')})(:(asc|desc))?`;
  if (!new RegExp(`^${field}(,${field})*$`).test(value)) {
    throw new InvalidArgumentError(
      'Sort fields must be price or validity, optionally followed by :asc or :desc',
    );
  }
  return value;
}

export function createProgram(
  select: (command: ParsedCommand) => void,
  output?: { out: (text: string) => void; err: (text: string) => void },
): Command {
  const program = new Command('ncell')
    .description('Ncell account CLI')
    .version(version, '-V, --version', 'Print version')
    .helpOption('-h, --help', 'Print help')
    .option('--json', 'Print structured JSON output')
    .exitOverride()
    .showHelpAfterError();
  if (output) program.configureOutput({ writeOut: output.out, writeErr: output.err });
  program.enablePositionalOptions();
  const action =
    (name: string) =>
    (...values: unknown[]) => {
      const cmd = values.at(-1) as Command;
      if (
        name.startsWith('plans ') &&
        cmd.parent &&
        ['category', 'sort'].some((option) => cmd.parent?.getOptionValueSource(option) === 'cli')
      ) {
        throw new Error('Use plan options after the subcommand');
      }
      const options = { ...cmd.optsWithGlobals<ParsedCommand>(), ...cmd.opts<ParsedCommand>() };
      select({
        ...options,
        command: name,
        args: cmd.processedArgs.flat().map(String),
        json: !!options.json,
      });
    };
  const login = program
    .command('login')
    .description('Request an OTP and log in.')
    .argument('<number>', 'Ncell number')
    .option('--verify', '')
    .action(action('login'));
  void login;
  const account = program.command('account').description('Manage saved accounts');
  account
    .command('add')
    .description('Save an account without switching')
    .argument('<number>', 'Ncell number')
    .option('--verify', '')
    .action(action('account add'));
  account.command('list').description('List saved accounts').action(action('account list'));
  account
    .command('switch')
    .description('Switch to a saved account')
    .argument('<number>', 'Ncell number')
    .action(action('account switch'));
  account
    .command('remove')
    .description('Remove a saved account locally')
    .argument('<number>', 'Ncell number')
    .action(action('account remove'));
  program.command('status').description('Show session status').action(action('status'));
  program.command('logout').description('Remove the active account').action(action('logout'));
  program.command('docs').description('Open documentation').action(action('docs'));
  program.command('refresh').description('Rotate tokens').action(action('refresh'));
  program
    .command('balance')
    .description('Query balance, data, voice and SMS')
    .action(action('balance'));
  program.command('profile').description('Owner Information').action(action('profile'));
  const sms = program.command('sms').description('Send SMS');
  sms
    .command('send-free')
    .description('Send a free SMS to a Ncell number')
    .argument('<number>', 'Ncell number')
    .argument('<text>', 'SMS message; use double quotes for spaces')
    .action(action('sms send-free'));
  const plans = program
    .command('plans')
    .description('Browse, search and subscribe to plans')
    .option('--category <id>', '', positive, DEFAULT_PLAN_CATEGORY)
    .option('--sort <fields>', 'Sort by a column', sortFields, 'price')
    .action(action('plans'));
  plans
    .command('categories')
    .description('List plans categories')
    .action(action('plans categories'));
  plans
    .command('search')
    .description('Search plans within a category')
    .argument('<keyword>', 'Search query; use double quotes for spaces')
    .option('--category <id>', '', positive, DEFAULT_PLAN_CATEGORY)
    .option('--sort <fields>', 'Sort by a column', sortFields, 'price')
    .action(action('plans search'));
  plans
    .command('subscribe')
    .description('Subscribe to a plan')
    .argument('<id>', 'Plan ID from the plans list')
    .option('--category <id>', '', positive, DEFAULT_PLAN_CATEGORY)
    .option('--yes', 'Skip the confirmation prompt (required for scripts and pipes)')
    .option('--dry-run', 'Show what would be bought without spending anything')
    .action(action('plans subscribe'));
  const game = program.command('game').description('Game status, rewards and leaderboard');
  for (const kind of ['spin', 'scratch', 'math']) {
    game
      .command(kind)
      .description(`Play ${kind} game`)
      .option('--count <count>', 'Number of games to play', parseCount, 1)
      .option(
        '--delay <duration>',
        'Delay between games: seconds by default, or use s, m, h (e.g. 1.5m)',
        parseDelay,
        0,
      )
      .action(action(`game ${kind}`));
  }
  const gameDescriptions = {
    'check-in': 'Claim daily check-in reward',
    status: 'List game tasks, rewards and current progress',
    ranks: 'Show weekly ranks, performance and prizes',
  };
  for (const [name, description] of Object.entries(gameDescriptions)) {
    game
      .command(name)
      .description(description)
      .action(action(`game ${name}`));
  }
  game
    .command('claim-task')
    .description('Claim tasks')
    .argument('<ids...>', 'Task IDs separated by commas')
    .action(action('game claim-task'));
  const script = program.command('script').description('Manage reusable scripts');
  const scriptDescriptions = {
    create: 'Create a script',
    run: 'Run a script',
    edit: 'Open a script',
    delete: 'Delete a script',
  };
  for (const [name, description] of Object.entries(scriptDescriptions)) {
    script
      .command(name)
      .description(description)
      .argument('<file>', 'Script name or path; use double quotes for spaces')
      .action(action(`script ${name}`));
  }
  script.command('list').description('List saved scripts').action(action('script list'));
  // Commander scopes parent options when positional parsing is enabled.
  // Declare the global flag on descendants so it also works after any command.
  const globals = (parent: Command): void => {
    for (const child of parent.commands) {
      child.helpOption('-h, --help', 'Print help');
      child.option('--json', 'Print structured JSON output');
      globals(child);
    }
  };
  globals(program);
  return program;
}

export function validateCommand(command: ParsedCommand): ParsedCommand {
  if (command.command === 'game claim-task') {
    command.args = command.args.flatMap((value) => value.split(','));
    if (command.args.includes('all')) {
      if (command.args.length !== 1) throw new Error('Use all alone, without task IDs');
    } else
      for (const id of command.args) {
        if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1)
          throw new Error('Task IDs must be positive integers');
      }
  }
  // Validate destinations before scripts make their first request.
  if (
    ['login', 'account add', 'account switch', 'account remove', 'sms send-free'].includes(
      command.command,
    )
  ) {
    if (!/^(\+977)?9\d{9}$/.test(command.args[0] ?? '')) {
      throw new Error('Use a 10-digit Nepal mobile number, optionally prefixed with +977');
    }
  }
  if (command.command === 'sms send-free' && !command.args[1]?.trim())
    throw new Error('SMS text cannot be empty');
  if (command.command === 'plans search' && !command.args[0]?.trim())
    throw new Error('Search keyword cannot be empty');
  if (command.command === 'plans subscribe' && !command.args[0]?.trim())
    throw new Error('Plan ID cannot be empty');
  return command;
}

export function parseCommand(
  argv: string[],
  output?: { out: (text: string) => void; err: (text: string) => void },
): ParsedCommand {
  let selected: ParsedCommand | undefined;
  const program = createProgram((command) => {
    selected = command;
  }, output);
  program.parse(argv, { from: 'user' });
  if (!selected) throw new Error('Choose a command. Run ncell --help');
  return validateCommand(selected);
}
