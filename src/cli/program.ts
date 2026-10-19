import { DEFAULT_PLAN_CATEGORY } from '../core/catalog.js';
import { createInterface } from 'node:readline/promises';
import { NcellApp, parseCount } from '../app.js';
import type { GameKind } from '../app.js';
import { NcellError } from '../core/index.js';
import {
  ScriptLibrary,
  ScriptExecutionError,
  parseScript,
  executeScript,
  tokenize,
} from '../scripts.js';
import { CommanderError } from 'commander';
import { Formatter, planPrice } from './format.js';
import { parseCommand } from './parse.js';
import type { ParsedCommand } from './parse.js';
import { CompletionEngine } from './completion.js';
import { openDocs } from './open.js';
import { runInteractive } from './interactive.js';
import type { InteractiveSession } from './interactive.js';

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  prompt: (question: string) => Promise<string>;
  color: boolean;
  terminal: boolean;
}
export interface CliOptions {
  app?: NcellApp;
  scripts?: ScriptLibrary;
  io?: Partial<CliIO>;
  /** Alternate terminal driver for embedders and deterministic integration tests. */
  interactive?: (session: InteractiveSession) => Promise<void>;
}
interface Context {
  app: NcellApp;
  scripts: ScriptLibrary;
  io: CliIO;
  formatter: Formatter;
  metadata?: { event: string; step: number; total: number; line: number; command: string };
}

export async function terminalPrompt(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once('close', () => reject(new Error('Could not read terminal input')));
      reader.question(question).then((answer) => resolve(answer.trim()), reject);
    });
  } finally {
    reader.close();
  }
}

function emit(context: Context, value: unknown): void {
  context.formatter.json(context.metadata ? { ...context.metadata, result: value } : value);
}
function result(context: Context, command: ParsedCommand, value: unknown, human: () => void): void {
  if (command.json) emit(context, value);
  else human();
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Spending money needs an explicit yes: a flag for scripts, or a typed
 * confirmation when a person is at the keyboard. Piped input can never
 * confirm. `stdinTTY` defaults to the real stdin check and exists so tests
 * can simulate a terminal.
 */
export async function confirmSubscribe(
  io: Pick<CliIO, 'prompt'>,
  name: string,
  price: string,
  yes: boolean,
  stdinTTY: boolean | undefined = process.stdin.isTTY,
): Promise<void> {
  if (yes) return;
  if (stdinTTY !== true)
    throw new Error('Refusing to subscribe without --yes in non-interactive mode');
  const answer = await io.prompt(`Subscribe to ${name} for ${price}? [y/N] `);
  if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
    throw new Error('Subscription cancelled');
}

async function execute(command: ParsedCommand, context: Context): Promise<void> {
  const { app, formatter: format } = context;
  const number = command.args[0] ?? '';
  const text = command.args[1] ?? '';
  switch (command.command) {
    case 'login':
    case 'account add': {
      if (!command.verify) {
        const request = await app.requestOtp(number);
        if (command.json) emit(context, request);
        else
          format.message(
            `OTP requested. Check your SMS. To resume later: ncell ${command.command} ${number} --verify`,
          );
      }
      const otp = await context.io.prompt('Enter OTP: ');
      const response = await app.verifyOtp(number, otp, { activate: command.command === 'login' });
      result(context, command, response, () =>
        format.message(
          command.command === 'login'
            ? 'Logged in. Session saved in your system credential store.'
            : 'Account saved without switching.',
        ),
      );
      return;
    }
    case 'status': {
      const response = await app.status();
      result(context, command, response, () => format.status(object(response)));
      return;
    }
    case 'account list': {
      const response = await app.listAccounts();
      result(context, command, { accounts: response }, () =>
        format.accounts({
          accounts: response.map((a) => ({ number: a.msisdn, active: a.active })),
        }),
      );
      return;
    }
    case 'logout': {
      const response = await app.logout();
      result(context, command, response, () => format.message('Active account removed locally.'));
      return;
    }
    case 'docs': {
      const url = await openDocs();
      result(context, command, { opened: url }, () =>
        format.message(`Opened documentation at ${url}.`),
      );
      return;
    }
    case 'account switch': {
      const response = await app.switchAccount(number);
      result(context, command, response, () =>
        format.message(`Switched to ${number.replace(/^\+977/, '')}.`),
      );
      return;
    }
    case 'account remove': {
      const response = await app.removeAccount(number);
      result(context, command, response, () =>
        format.message(`Removed ${number.replace(/^\+977/, '')}.`),
      );
      return;
    }
    case 'refresh': {
      const response = await app.refresh();
      result(context, command, response, () => format.message('Tokens refreshed.'));
      return;
    }
    case 'balance': {
      const response = await app.balance();
      result(context, command, response, () => format.balance(response));
      return;
    }
    case 'profile': {
      const response = await app.profile();
      const session = command.json ? undefined : await app.status();
      result(context, command, response, () =>
        format.profile({ ...response, msisdn: session?.account }),
      );
      return;
    }
    case 'sms send-free': {
      const response = await app.sendFreeSms(number, text);
      result(context, command, response, () =>
        format.message(`SMS sent to ${number.replace(/^\+977/, '')}.`),
      );
      return;
    }
    case 'plans categories': {
      const response = await app.categories();
      result(context, command, response, () => format.categories(response));
      return;
    }
    case 'plans':
    case 'plans search': {
      const response = await app.plans({
        category: command.category ?? DEFAULT_PLAN_CATEGORY,
        keyword: command.command === 'plans search' ? number : '',
        ...(command.sort ? { sort: command.sort } : {}),
      });
      result(context, command, response, () => format.plans(response, command.sort));
      return;
    }
    case 'plans subscribe': {
      const category = command.category ?? DEFAULT_PLAN_CATEGORY;
      // Look up the plan first so the prompt can show its real name and
      // price. The lookup is served from the plan cache when the completion
      // dropdown already fetched this page.
      const catalog = await app.plans({ category });
      const found = Array.isArray(catalog.availablePackages)
        ? catalog.availablePackages.map(object).find((item) => String(item.id) === number)
        : undefined;
      if (found === undefined)
        throw new NcellError(
          'Plan not found in this category. Use ncell plans to list available plans',
        );
      const name = String(object(found.displayInfo).displayName ?? '').trim();
      const price = planPrice(found.productOfferingPrice);
      if (command.dryRun === true) {
        result(context, command, { dry_run: true, id: number, name, price }, () =>
          format.message(`Would subscribe to ${name} for ${price}.`),
        );
        return;
      }
      await confirmSubscribe(context.io, name, price, command.yes === true);
      const response = await app.subscribe(number, category);
      result(context, command, response, () => format.message(`Subscribed to ${name}.`));
      return;
    }
    case 'game status': {
      const response = await app.taskStatus();
      result(context, command, response, () => format.taskStatus(response));
      return;
    }
    case 'game ranks': {
      const response = await app.ranks();
      result(context, command, response, () => format.ranks(response));
      return;
    }
    case 'game check-in': {
      const response = await app.checkIn();
      result(context, command, response, () => format.checkIn(response));
      return;
    }
    case 'game claim-task': {
      const response = await app.claimTasks(
        command.args[0] === 'all' ? 'all' : command.args.map(Number),
        (item) => {
          if (command.json) emit(context, item);
          else format.claimTask(item);
        },
      );
      if (!response.results.length)
        result(context, command, { claimed: [] }, () =>
          format.message('No tasks available to claim.'),
        );
      if (response.failed)
        throw new NcellError('One or more tasks could not be claimed', {
          code: 'GAME_TASKS',
          response,
        });
      return;
    }
    case 'game spin':
    case 'game scratch':
    case 'game math': {
      const kind = command.command.slice(5) as GameKind;
      const count = parseCount(command.count ?? 1);
      const repeated = count === 'all' || count > 1;
      const response = await app[kind]({
        count,
        delay: command.delay ?? 0,
        manualAnswer: async (question) => {
          const options = Array.isArray(question.options) ? question.options.join(', ') : '';
          for (;;) {
            const answer = await context.io.prompt(
              `Unsupported math question: ${String(question.question ?? '')}\nOptions: ${options}\nTime limit: ${String(question.time ?? 'Unknown')} seconds\nAnswer: `,
            );
            if (!answer) throw new Error('No answer entered; no answer submitted');
            if (
              Number.isFinite(Number(answer)) &&
              Array.isArray(question.options) &&
              question.options.some((value) => Number(value) === Number(answer))
            )
              return answer;
            context.io.err('Choose one of the displayed answer values.\n');
          }
        },
        onEvent: (event) => {
          if (event.event === 'wait') {
            if (!command.json && context.io.terminal) {
              context.io.err(
                event.seconds > 0
                  ? `\rNext game in ${event.seconds.toFixed(1)}s\u001b[K`
                  : '\r\u001b[K',
              );
            }
          } else if (event.event === 'game_start') {
            if (command.json) emit(context, event);
            else if (kind === 'math') {
              if (event.game > 1) format.message('');
              if (repeated) {
                format.progress(
                  `Game ${event.game}${event.total === undefined ? '' : ` of ${event.total}`}`,
                );
                format.message('');
              }
              format.mathHeader();
            }
          } else if (event.event === 'answer') {
            result(context, command, event.result, () => format.mathAnswer(event.result));
          } else {
            result(context, command, event.result, () =>
              kind === 'math'
                ? format.mathSummary(event.result)
                : format.reward(kind, event.result, event.game),
            );
          }
        },
      });
      if (response.stop === 'insufficient_tokens')
        result(context, command, { stop: response.stop, games: response.games }, () =>
          format.message('No tokens left for another game.'),
        );
      return;
    }
    case 'script list': {
      const scripts = await context.scripts.list();
      result(context, command, { scripts }, () => {
        if (!scripts.length) format.message('No saved scripts.');
        else {
          format.message('Script');
          format.message('-'.repeat(Math.max(6, ...scripts.map((s) => s.length))));
          scripts.forEach((s) => format.message(s));
        }
      });
      return;
    }
    case 'script create': {
      const file = await context.scripts.create(number);
      result(context, command, { created: file }, () =>
        format.message(`Created ${file}. Run it with ncell script run after saving your changes.`),
      );
      return;
    }
    case 'script edit': {
      await context.scripts.edit(number);
      if (command.json) emit(context, { edited: number });
      return;
    }
    case 'script delete': {
      await context.scripts.delete(number);
      result(context, command, { deleted: number }, () => format.message(`Deleted ${number}.`));
      return;
    }
    case 'script run': {
      const source = await context.scripts.read(number);
      const steps = parseScript(source, (argv) => {
        // There is no interactive subcommand anymore; answer the word here
        // so scripts keep the friendly error instead of an unknown command.
        if (argv[0] === 'interactive')
          throw new Error('Interactive mode cannot run inside a script');
        const parsed = parseCommand(argv, { out: () => {}, err: () => {} });
        if (parsed.command.startsWith('script '))
          throw new Error('Nested script commands are not supported');
        return parsed;
      });
      await executeScript(steps, async (step, index, total) => {
        const json = command.json || step.parsed.json;
        if (!json) {
          if (index > 1) format.message('');
          format.progress(`Step ${index} of ${total} · ${step.command}`);
          format.message('');
        }
        const child: Context = {
          ...context,
          metadata: { event: 'result', step: index, total, line: step.line, command: step.command },
        };
        await execute({ ...step.parsed, json }, child);
      });
      if (command.json) emit(context, { event: 'complete', steps: steps.length });
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command.command}`);
  }
}

/** Parse and execute the CLI with injectable SDK, scripts and terminal I/O. */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const io: CliIO = {
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    prompt: terminalPrompt,
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    terminal: !!process.stderr.isTTY,
    ...options.io,
  };
  let command: ParsedCommand | undefined;
  // Bare `ncell` opens the interactive shell. Only the global --json flag
  // may ride along (and is rejected inside); anything else goes through the
  // parser so help, version and unknown options keep their exact behavior.
  const bare = argv.every((arg) => arg === '--json');
  if (!bare) {
    try {
      command = parseCommand(argv, argv.includes('--json') ? { ...io, err: () => {} } : io);
    } catch (error) {
      if (argv.includes('--json') && error instanceof CommanderError && error.exitCode > 0)
        throw new Error(error.message);
      throw error;
    }
  }
  const context: Context = {
    app: options.app ?? new NcellApp(),
    scripts: options.scripts ?? new ScriptLibrary(),
    io,
    formatter: new Formatter({ write: io.out, color: io.color }),
  };
  if (bare) {
    if (argv.includes('--json')) throw new Error('Interactive mode does not support --json');
    const completion = new CompletionEngine({
      categories: () => context.app.categories(),
      plans: (category) => context.app.plans({ category }),
      scripts: context.scripts,
    });
    await (options.interactive ?? runInteractive)({
      completion,
      out: io.out,
      color: io.color,
      execute: async (line) => {
        const args = tokenize(line);
        if (args[0] === 'ncell') args.shift();
        // There is no interactive subcommand anymore: bare `ncell` opens the
        // shell, so both spellings are answered here instead of executing.
        if (!args.length || args[0] === 'interactive')
          throw new Error('Already in interactive mode');
        let parsed: ParsedCommand;
        try {
          parsed = parseCommand(args, { out: io.out, err: () => {} });
        } catch (error) {
          if (error instanceof CommanderError && error.exitCode === 0) return;
          throw error;
        }
        let succeeded = false;
        try {
          await runCli(args, { ...options, app: context.app, scripts: context.scripts, io });
          succeeded = true;
        } catch (error) {
          if (!(error instanceof CommanderError && error.exitCode === 0)) throw error;
        } finally {
          // A cancelled or failed command changes nothing, so keep the
          // caches; scripts always invalidate since a half-finished script
          // may have subscribed.
          if (
            parsed.command === 'script run' ||
            (succeeded &&
              (['login', 'logout', 'refresh', 'plans categories', 'plans subscribe'].includes(
                parsed.command,
              ) ||
                parsed.command.startsWith('account ')))
          )
            completion.invalidate();
        }
      },
    });
    return;
  }
  if (command) await execute(command, context);
}

export function errorOutput(error: unknown, json: boolean): string {
  let cause = error;
  while (cause instanceof Error && cause.cause) cause = cause.cause;
  let message = error instanceof Error ? error.message : String(error);
  if (cause instanceof NcellError && cause.status !== undefined && !message.includes('(HTTP '))
    message += ` (HTTP ${cause.status})`;
  if (!json) return `Error: ${message}\n`;
  return `${JSON.stringify(
    {
      error: message,
      ...(error instanceof ScriptExecutionError
        ? { step: error.step, total: error.total, line: error.line }
        : {}),
      ...(cause instanceof NcellError
        ? { code: cause.code, ...(cause.status !== undefined ? { status: cause.status } : {}) }
        : {}),
      ...(cause instanceof NcellError && cause.response !== undefined
        ? { response: cause.response }
        : {}),
    },
    null,
    2,
  )}\n`;
}
