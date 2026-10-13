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
import { Formatter } from './format.js';
import { parseCommand } from './parse.js';
import type { ParsedCommand } from './parse.js';
import { CompletionEngine } from './completion.js';
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
      const response = await app.subscribe(number, command.category ?? DEFAULT_PLAN_CATEGORY);
      result(context, command, response, () => format.message('Plan subscribed successfully.'));
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
            else {
              if (event.game > 1) format.message('');
              if (repeated) {
                format.progress(
                  `Game ${event.game}${event.total === undefined ? '' : ` of ${event.total}`}`,
                );
                format.message('');
              }
              if (kind === 'math') format.mathHeader();
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
        const parsed = parseCommand(argv, { out: () => {}, err: () => {} });
        if (parsed.command.startsWith('script '))
          throw new Error('Nested script commands are not supported');
        if (parsed.command === 'interactive')
          throw new Error('Interactive mode cannot run inside a script');
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
  let command: ParsedCommand;
  try {
    command = parseCommand(argv, argv.includes('--json') ? { ...io, err: () => {} } : io);
  } catch (error) {
    if (argv.includes('--json') && error instanceof CommanderError && error.exitCode > 0)
      throw new Error(error.message);
    throw error;
  }
  const context: Context = {
    app: options.app ?? new NcellApp(),
    scripts: options.scripts ?? new ScriptLibrary(),
    io,
    formatter: new Formatter({ write: io.out, color: io.color }),
  };
  if (command.command === 'interactive') {
    if (command.json) throw new Error('Interactive mode does not support --json');
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
        if (!args.length) return;
        let parsed: ParsedCommand;
        try {
          parsed = parseCommand(args, { out: io.out, err: () => {} });
        } catch (error) {
          if (error instanceof CommanderError && error.exitCode === 0) return;
          throw error;
        }
        if (parsed.command === 'interactive') throw new Error('Already in interactive mode');
        try {
          await runCli(args, { ...options, app: context.app, scripts: context.scripts, io });
        } catch (error) {
          if (!(error instanceof CommanderError && error.exitCode === 0)) throw error;
        } finally {
          if (
            [
              'login',
              'logout',
              'refresh',
              'script run',
              'plans categories',
              'plans subscribe',
            ].includes(parsed.command) ||
            parsed.command.startsWith('account ')
          )
            completion.invalidate();
        }
      },
    });
    return;
  }
  await execute(command, context);
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
