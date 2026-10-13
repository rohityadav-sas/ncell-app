import { Command, InvalidArgumentError } from 'commander';
import { createRequire } from 'node:module';
import { parseCount, parseDelay } from '../app.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface ParsedCommand {
  command: string;
  args: string[];
  json: boolean;
  verify?: boolean;
  count?: number | 'all';
  delay?: number;
  category?: number;
  sort?: string;
}

function positive(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new InvalidArgumentError('Use a positive integer');
  }
  return number;
}

function sortFields(value: string): string {
  if (!/^(price|validity)(:(asc|desc))?(,(price|validity)(:(asc|desc))?)*$/.test(value)) {
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
    .version(version)
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
    .description('Request an SMS code and log in. Use --verify to resume a pending login')
    .argument('<number>')
    .option('--verify', 'Resume a pending OTP')
    .action(action('login'));
  void login;
  const account = program.command('account').description('Manage saved accounts');
  account
    .command('add')
    .description('Save an account without switching')
    .argument('<number>')
    .option('--verify', 'Resume a pending OTP')
    .action(action('account add'));
  account.command('list').description('List saved accounts').action(action('account list'));
  account
    .command('switch')
    .description('Switch to a saved account')
    .argument('<number>')
    .action(action('account switch'));
  account
    .command('remove')
    .description('Remove a saved account locally')
    .argument('<number>')
    .action(action('account remove'));
  program.command('status').description('Show local session status').action(action('status'));
  program
    .command('logout')
    .description('Remove the active account locally')
    .action(action('logout'));
  program.command('refresh').description('Rotate saved tokens').action(action('refresh'));
  program
    .command('balance')
    .description('Query balances and pack details')
    .action(action('balance'));
  program.command('profile').description('Query the subscriber profile').action(action('profile'));
  const sms = program.command('sms').description('Send SMS messages');
  sms
    .command('send-free')
    .description('Send a free SMS')
    .argument('<number>')
    .argument('<text>')
    .action(action('sms send-free'));
  const plans = program
    .command('plans')
    .description('Browse, search and subscribe to plans')
    .option('--category <id>', 'Catalog category', positive, 66)
    .option(
      '--sort <fields>',
      'Ordered price/validity fields with :asc or :desc',
      sortFields,
      'price',
    )
    .action(action('plans'));
  plans
    .command('categories')
    .description('List catalog categories')
    .action(action('plans categories'));
  plans
    .command('search')
    .description('Search plans within a category')
    .argument('<keyword>')
    .option('--category <id>', 'Catalog category', positive, 66)
    .option('--sort <fields>', 'Ordered price/validity fields', sortFields, 'price')
    .action(action('plans search'));
  plans
    .command('subscribe')
    .description('Subscribe to a plan. Paid packs charge your Ncell account')
    .argument('<id>')
    .option('--category <id>', 'Catalog category', positive, 66)
    .action(action('plans subscribe'));
  const game = program.command('game').description('Game status, rewards and leaderboard');
  for (const kind of ['spin', 'scratch', 'math']) {
    game
      .command(kind)
      .description(`Play ${kind} using game tokens`)
      .option('--count <count>', 'Number of games, or all', parseCount, 1)
      .option('--delay <duration>', 'Delay between games: seconds or s, m, h', parseDelay, 0)
      .action(action(`game ${kind}`));
  }
  const gameDescriptions = {
    'check-in': 'Claim the daily check-in reward',
    status: 'List tasks, progress and rewards',
    ranks: 'Show your performance, prizes and leaderboard',
  };
  for (const [name, description] of Object.entries(gameDescriptions)) {
    game
      .command(name)
      .description(description)
      .action(action(`game ${name}`));
  }
  game
    .command('claim-task')
    .description('Claim task IDs or all completed, unclaimed tasks')
    .argument('<ids...>')
    .action(action('game claim-task'));
  const script = program
    .command('script')
    .description('Create, manage and run saved command scripts');
  const scriptDescriptions = {
    create: 'Create a saved script and open it in your text editor',
    run: 'Validate and run a saved script or command file',
    edit: 'Open a saved script in your text editor',
    delete: 'Delete a saved script',
  };
  for (const [name, description] of Object.entries(scriptDescriptions)) {
    script
      .command(name)
      .description(description)
      .argument('<file>')
      .action(action(`script ${name}`));
  }
  script.command('list').description('List saved scripts').action(action('script list'));
  // Commander scopes parent options when positional parsing is enabled.
  // Declare the global flag on descendants so it also works after any command.
  const globals = (parent: Command): void => {
    for (const child of parent.commands) {
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
