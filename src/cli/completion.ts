import { PackCatalog } from './pack-completion.js';
import type { Argument, Command, Option } from 'commander';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ScriptLibrary } from '../scripts.js';
import { createProgram, SORT_FIELDS } from './parse.js';

export interface Suggestion {
  value: string;
  description: string;
  kind: 'command' | 'option' | 'value' | 'file' | 'directory';
  branch?: boolean;
  continueValue?: boolean;
  subscriptionCategory?: number;
}
export interface Completion {
  items: Suggestion[];
  start: number;
  end: number;
  prefix: string;
  hint?: string;
  sortHint?: string;
  notice?: string;
  categoryPanel?: boolean;
  packPanel?: boolean;
}
interface Word {
  value: string;
  start: number;
  end: number;
  closed: boolean;
  quoted: boolean;
}

/** Tolerant editor tokens; submission still uses the strict script tokenizer. */
export function editorWords(input: string): Word[] {
  const result: Word[] = [];
  let value = '',
    quote = '',
    start = -1,
    quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (start < 0 && !/\s/.test(char)) start = index;
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
    } else if (/\s/.test(char)) {
      if (start >= 0) result.push({ value, start, end: index, closed: true, quoted });
      value = '';
      start = -1;
      quoted = false;
    } else value += char;
  }
  if (start >= 0) result.push({ value, start, end: input.length, closed: !quote, quoted });
  return result;
}

export function cleanLabel(value: unknown): string {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\p{Cc}\p{Cf}]/gu, '');
}

function options(command: Command): Option[] {
  return command.createHelp().visibleOptions(command);
}

function remainingArgument(command: Command, count: number): Argument | undefined {
  return (
    command.registeredArguments[count] ??
    (command.registeredArguments.at(-1)?.variadic ? command.registeredArguments.at(-1) : undefined)
  );
}

function completeArgument(argument: Argument, word: Word | undefined): boolean {
  if (!word?.closed || !word.value) return false;
  if (argument.name() === 'number') return /^(\+977)?9\d{9}$/.test(word.value);
  // A text value is unambiguous once its quote is closed or whitespace follows it.
  return word.quoted;
}

function optionValueHint(option: Option): string {
  switch (option.long) {
    case '--category':
      return '<category> Choose a category';
    case '--count':
      return '<count> Positive number, or all';
    case '--delay':
      return '<delay> Duration such as 1.5s, 2m, 1h';
    default:
      return option.description;
  }
}

const quoteFile = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

export class CompletionEngine {
  readonly program: Command;
  readonly packs: PackCatalog | undefined;
  #categories: Promise<Suggestion[]> | undefined;
  #generation = 0;
  #retryAfter = 0;
  #categoryValues: Suggestion[] | undefined;
  #categoryError: string | undefined;
  onChange: (() => void) | undefined;

  constructor(
    readonly dependencies: {
      categories: () => Promise<unknown>;
      plans?: (category: number) => Promise<unknown>;
      now?: () => number;
      scripts: Pick<ScriptLibrary, 'list' | 'directory'>;
      cwd?: string;
      program?: Command;
    },
  ) {
    if (dependencies.plans)
      this.packs = new PackCatalog(
        dependencies.categories,
        dependencies.plans,
        () => this.onChange?.(),
        dependencies.now,
      );
    this.program =
      dependencies.program ?? createProgram(() => {}, { out: () => {}, err: () => {} });
  }

  invalidate(): void {
    this.packs?.invalidate();
    this.#generation++;
    this.#categories = undefined;
    this.#retryAfter = 0;
    this.#categoryValues = undefined;
    this.#categoryError = undefined;
  }

  async categorySuggestions(): Promise<Suggestion[]> {
    if (Date.now() < this.#retryAfter)
      throw new Error('Could not load categories; press Ctrl+Space to retry');
    if (!this.#categories) {
      const generation = this.#generation;
      this.#categories = this.dependencies
        .categories()
        .then((raw) => {
          const tags = (raw as { tags?: unknown })?.tags;
          if (!Array.isArray(tags)) throw new Error('Invalid category response');
          const values = tags.flatMap((tag: Record<string, unknown>) => {
            const id = String(tag.id ?? '');
            if (!/^\d+$/.test(id)) return [];
            const types = Array.isArray(tag.categories)
              ? tag.categories
                  .map((entry: Record<string, unknown>) => cleanLabel(entry.displayName).trim())
                  .filter(Boolean)
                  .join(', ')
              : '';
            return [
              {
                value: id,
                description: [cleanLabel(tag.name).trim(), types].filter(Boolean).join(' · '),
                kind: 'value' as const,
              },
            ];
          });
          if (generation === this.#generation) {
            this.#categoryValues = values;
            this.onChange?.();
          }
          return values;
        })
        .catch(() => {
          if (generation === this.#generation) {
            this.#categories = undefined;
            this.#retryAfter = Date.now() + 10_000;
            this.#categoryError = 'Could not load categories; press Ctrl+Space to retry';
            this.onChange?.();
          }
          // Never expose an API error body or account details inside the editor.
          throw new Error('Could not load categories; press Ctrl+Space to retry');
        });
    }
    return this.#categories;
  }

  async files(prefix: string, command: Command): Promise<Suggestion[]> {
    if (command.parent?.name() !== 'script' || command.name() === 'create') return [];
    const savedOnly = command.name() !== 'run';
    const split = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\')) + 1;
    const directory = prefix.slice(0, split);
    if (savedOnly && directory) return [];
    const name = prefix.slice(split).toLocaleLowerCase();
    const items = new Map<string, Suggestion>();
    if (!directory) {
      for (const value of await this.dependencies.scripts.list()) {
        if (value.toLocaleLowerCase().startsWith(name) && !/[\p{Cc}\p{Cf}"']/u.test(value))
          items.set(value, { value: quoteFile(value), description: 'Saved script', kind: 'file' });
      }
    }
    if (!savedOnly) {
      const expanded =
        directory.startsWith('~/') || directory.startsWith('~\\')
          ? resolve(homedir(), directory.slice(2))
          : directory;
      const root = isAbsolute(expanded)
        ? expanded
        : resolve(this.dependencies.cwd ?? process.cwd(), expanded || '.');
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (
            !entry.name.toLocaleLowerCase().startsWith(name) ||
            /[\p{Cc}\p{Cf}"']/u.test(entry.name)
          )
            continue;
          if (entry.name.startsWith('.') && !name.startsWith('.')) continue;
          if (entry.isDirectory() ? !directory : !(entry.isFile() && /\.ncell$/i.test(entry.name)))
            continue;
          const value =
            (directory.startsWith('~/') || directory.startsWith('~\\')
              ? expanded + sep
              : directory) +
            entry.name +
            (entry.isDirectory() ? sep : '');
          if (!items.has(value))
            items.set(value, {
              value: quoteFile(value),
              description: entry.isDirectory() ? 'Directory' : 'Saved script',
              kind: entry.isDirectory() ? 'directory' : 'file',
            });
        }
      } catch {
        /* A missing or inaccessible directory has no candidates. */
      }
    }
    return [...items.values()].sort((a, b) => a.value.localeCompare(b.value));
  }

  async suggest(input: string, cursor = input.length, explicit = false): Promise<Completion> {
    const before = input.slice(0, cursor);
    const words = editorWords(before);
    let active = !/\s$/.test(before) || words.at(-1)?.closed === false ? words.pop() : undefined;
    const full = editorWords(input).find((word) => word.start === active?.start);
    const result: Completion = {
      items: [],
      start: active?.start ?? cursor,
      end: full?.end ?? cursor,
      prefix: active?.value ?? '',
    };
    if (words[0]?.value === 'ncell') words.shift();
    let command = this.program;
    let pending: Option | undefined;
    let positional = 0,
      localOption = false,
      terminal = false,
      allIds = false;
    const used = new Set<string>();
    for (const word of words) {
      if (pending) {
        pending = undefined;
        continue;
      }
      if (word.value === '--') {
        terminal = true;
        continue;
      }
      if (!terminal && word.value.startsWith('-')) {
        const [flag, value] = word.value.split('=', 2);
        const option = options(command).find((item) => item.long === flag || item.short === flag);
        if (!option) return result;
        used.add(option.long ?? option.flags);
        if (option.long === '--help' || option.long === '--version') return result;
        if (option.long !== '--json') localOption = true;
        if ((option.required || option.optional) && value === undefined) pending = option;
        continue;
      }
      const child =
        !positional && !localOption && !terminal
          ? command.commands.find((child) => child.name() === word.value)
          : undefined;
      if (child) {
        command = child;
        localOption = false;
      } else if (remainingArgument(command, positional)) {
        if (allIds) return result;
        if (remainingArgument(command, positional)?.name() === 'ids' && word.value === 'all')
          allIds = true;
        positional++;
      } else return result;
    }
    // Values supplied with --flag=value share a replacement range with their flag.
    let valuePrefix = '';
    if (active?.value.startsWith('--') && active.value.includes('=')) {
      const equal = active.value.indexOf('=');
      const option = options(command).find((item) => item.long === active!.value.slice(0, equal));
      if (option?.required || option?.optional) {
        pending = option;
        valuePrefix = active.value.slice(0, equal + 1);
        active = { ...active, value: active.value.slice(equal + 1) };
      }
    }
    const prefix = active?.value ?? '';
    if (explicit && pending?.long === '--category' && this.#categoryError) this.invalidate();
    if (pending && !explicit && !prefix) {
      result.hint = optionValueHint(pending);
      if (pending.long === '--sort')
        result.sortHint = 'add , for another field (price:asc,validity:asc)';
      return result;
    }
    if (pending) {
      let values: Suggestion[] = [];
      if (pending.long === '--category') {
        result.categoryPanel = true;
        if (this.#categoryValues) values = this.#categoryValues;
        else {
          void this.categorySuggestions().catch(() => {});
          result.notice = this.#categoryError ?? 'Loading categories…';
        }
      } else if (pending.long === '--sort') {
        const comma = prefix.lastIndexOf(',') + 1;
        const earlier = prefix.slice(0, comma);
        const usedFields = new Set(earlier.split(',').map((field) => field.split(':')[0]));
        values = SORT_FIELDS.filter((field) => !usedFields.has(field)).flatMap((field) =>
          ['asc', 'desc'].map((direction) => ({
            value: `${earlier}${field}:${direction}`,
            description: direction === 'asc' ? 'Ascending' : 'Descending',
            kind: 'value' as const,
            continueValue: true,
          })),
        );
        result.sortHint = 'add , for another field (price:asc,validity:asc)';
      } else if (pending.long === '--count')
        values = [{ value: 'all', description: 'Use all game tokens', kind: 'value' }];
      else if (pending.argChoices)
        values = pending.argChoices.map((value) => ({
          value,
          description: pending!.description,
          kind: 'value',
        }));
      result.items = values
        .filter((item) => item.value.startsWith(prefix))
        .map((item) => ({ ...item, value: valuePrefix + item.value }));
      if (!result.sortHint) result.hint = optionValueHint(pending);
      return result;
    }
    const argument = allIds ? undefined : remainingArgument(command, positional);
    if (
      !prefix &&
      command !== this.program &&
      command.commands.length &&
      command.name() !== 'plans'
    )
      result.hint = 'Choose a subcommand';
    if (argument && prefix.startsWith('-'))
      result.hint = `<${argument.name()}>  ·  ${argument.description}${argument.required ? ' · Required' : ''}`;
    if (argument && !prefix.startsWith('-')) {
      if (!completeArgument(argument, active))
        result.hint = `<${argument.name()}>  ·  ${argument.description}${argument.required ? ' · Required' : ''}`;
      else {
        const next = command.registeredArguments[positional + 1];
        if (next)
          result.hint = `<${next.name()}>  ·  ${next.description}${next.required ? ' · Required' : ''}`;
      }
      if (!(explicit || prefix)) return result;
      if (argument.name() === 'id' && command.name() === 'subscribe' && this.packs) {
        result.packPanel = true;
        if (explicit && this.packs.error) this.packs.invalidate();
        const packs = this.packs.peek();
        if (!packs) {
          void this.packs.load().catch(() => {});
          const progress = this.packs.progress;
          result.notice =
            this.packs.error ??
            (progress
              ? `Loading packs · ${progress.completed}/${progress.total} categories`
              : 'Loading packs…');
        }
        const allWords = editorWords(input);
        const categoryToken = allWords.findIndex((word) => word.value === '--category');
        const inline = allWords.find((word) => word.value.startsWith('--category='));
        const chosen = inline
          ? Number(inline.value.split('=')[1])
          : categoryToken >= 0
            ? Number(allWords[categoryToken + 1]?.value)
            : undefined;
        result.items = (packs ?? [])
          .filter(
            (pack) =>
              (chosen === undefined || pack.categories.includes(chosen)) &&
              (pack.id.startsWith(prefix) ||
                pack.description.toLowerCase().includes(prefix.toLowerCase())),
          )
          .map((pack) => {
            const category = pack.categories.includes(66) ? 66 : Math.min(...pack.categories);
            return {
              value: pack.id,
              description: pack.description,
              kind: 'value' as const,
              ...(chosen === undefined && category !== 66
                ? { subscriptionCategory: category }
                : {}),
            };
          });
        return result;
      }

      if (argument.name() === 'file' && !active?.quoted)
        result.items = await this.files(prefix, command);
      else if (argument.name() === 'file' && active && !active.closed)
        result.items = await this.files(prefix, command);
      else if (argument.argChoices)
        result.items = argument.argChoices
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, description: argument.description, kind: 'value' }));
      else if (argument.name() === 'ids' && positional === 0 && 'all'.startsWith(prefix))
        result.items = [{ value: 'all', description: 'Claim all completed tasks', kind: 'value' }];
    }
    if ((!active && !explicit) || active?.quoted || terminal) return result;
    const commands: Suggestion[] =
      !positional && !localOption && !prefix.startsWith('-')
        ? command.commands
            .filter((child) => child.name() !== 'interactive')
            .map((child) => ({
              value: child.name(),
              description: child.description(),
              kind: 'command',
              branch: child.commands.length > 0 && child.name() !== 'plans',
            }))
        : [];
    if (command === this.program && !prefix.startsWith('-'))
      commands.push(
        {
          value: 'exit',
          description: 'Exit the interactive shell',
          kind: 'command',
        },
        {
          value: 'clear',
          description: 'Clear the screen',
          kind: 'command',
        },
      );
    const supplied = positional + Number(!!argument && completeArgument(argument, active));
    const missingRequired = command.registeredArguments.some(
      (item, index) => item.required && index >= supplied,
    );
    const flags: Suggestion[] = options(command)
      .filter(
        (option) =>
          !used.has(option.long ?? option.flags) && (!missingRequired || option.long === '--help'),
      )
      .map((option) => ({
        value: option.long ?? option.short ?? option.flags,
        description: option.description,
        kind: 'option',
      }));
    flags.sort(
      (a, b) =>
        Number(['--json', '--help', '--version'].includes(a.value)) -
        Number(['--json', '--help', '--version'].includes(b.value)),
    );
    result.items.push(...[...commands, ...flags].filter((item) => item.value.startsWith(prefix)));
    return result;
  }
}

export function acceptSuggestion(
  input: string,
  completion: Completion,
  suggestion: Suggestion,
): { input: string; cursor: number } {
  const continueValue = suggestion.kind === 'directory' || suggestion.continueValue;
  const existingSpace = /^\s/.test(input.slice(completion.end));
  const suffix = continueValue || existingSpace ? '' : ' ';
  const replacement =
    suggestion.value +
    (suggestion.subscriptionCategory === undefined
      ? ''
      : ` --category ${suggestion.subscriptionCategory}`) +
    suffix;
  return {
    input: input.slice(0, completion.start) + replacement + input.slice(completion.end),
    cursor: completion.start + replacement.length + (!continueValue && existingSpace ? 1 : 0),
  };
}
