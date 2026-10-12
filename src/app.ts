import { AccountService, NcellError } from './core/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountOptions } from './core/index.js';
import { GameSession, isInsufficientTokens } from './game/index.js';
import type { GameEndpoints } from './game/index.js';
import { parseSort, sortPlans } from './plans.js';
import type { PlanOptions } from './plans.js';

export type GameKind = 'spin' | 'scratch' | 'math';
export type GameCount = number | 'all';
export interface PlayOptions {
  count?: GameCount;
  /** Seconds, or a duration such as "1.5s", "2m", or "1.5h". */
  delay?: number | string;
  signal?: AbortSignal;
  manualAnswer?: (question: Record<string, unknown>) => Promise<string>;
  onEvent?: (event: GameEvent) => void | Promise<void>;
}
export type GameEvent =
  | { event: 'game_start'; game: number; total: number | undefined; kind: GameKind }
  | { event: 'wait'; seconds: number }
  | { event: 'answer'; game: number; result: Record<string, unknown> }
  | { event: 'result'; game: number; result: Record<string, unknown> };
export interface PlayResult {
  games: number;
  results: Record<string, unknown>[];
  stop: 'count' | 'insufficient_tokens';
}
export interface NcellOptions extends AccountOptions {
  gameEndpoints?: Partial<GameEndpoints>;
}

export function parseCount(value: string | number): GameCount {
  if (value === 'all') return value;
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    throw new NcellError('Count must be a positive integer or all');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new NcellError('Count must be a positive integer or all');
  }
  return count;
}

/** Convert a supported duration into seconds. */
export function parseDelay(value: string | number): number {
  const match = /^(\d+(?:\.\d*)?|\.\d+)([smh]?)$/.exec(String(value));
  if (!match) throw new NcellError('Delay must be a nonnegative duration: 1.5, 1.5s, 2m, or 1.5h');
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2] || 's'] ?? 1);
  if (!Number.isFinite(seconds) || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
    throw new NcellError('Delay is too large');
  }
  return seconds;
}

export async function delay(seconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let remaining = seconds * 1000;
  // Node timers cannot represent delays above a signed 32-bit integer.
  while (remaining > 0) {
    const chunk = Math.min(remaining, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, chunk);
      signal?.addEventListener('abort', abort, { once: true });
    });
    remaining -= chunk;
  }
}

/** Shared SDK implementation. Importing or constructing it never sends a request. */
export class NcellApp {
  readonly #accounts: AccountService;
  readonly #options: NcellOptions;
  #game: { identity: string; created: number; session: GameSession } | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #operation = new AsyncLocalStorage<boolean>();

  constructor(options: NcellOptions = {}) {
    this.#options = options;
    this.#accounts = new AccountService(options);
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operation.getStore()) {
      return Promise.reject(
        new NcellError('A progress callback cannot await another command on the same client', {
          code: 'REENTRANT_COMMAND',
        }),
      );
    }
    const result = this.#tail.then(() => this.#operation.run(true, operation));
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #accountChange<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      this.#game = undefined;
      return operation();
    });
  }

  requestOtp(number: string) {
    return this.#accountChange(() => this.#accounts.requestOtp(number));
  }
  verifyOtp(number: string, otp: string, options: { activate?: boolean } = {}) {
    return this.#accountChange(() => this.#accounts.verifyOtp(number, otp, options));
  }
  refresh() {
    return this.#accountChange(() => this.#accounts.refresh());
  }
  logout() {
    return this.#accountChange(() => this.#accounts.logout());
  }
  switchAccount(number: string) {
    return this.#accountChange(() => this.#accounts.switchAccount(number));
  }
  removeAccount(number: string) {
    return this.#accountChange(() => this.#accounts.removeAccount(number));
  }
  status() {
    return this.#serial(() => this.#accounts.status());
  }
  listAccounts() {
    return this.#serial(() => this.#accounts.listAccounts());
  }
  balance() {
    return this.#serial(() => this.#accounts.balance());
  }
  profile() {
    return this.#serial(() => this.#accounts.profile());
  }
  categories() {
    return this.#serial(() => this.#accounts.categories());
  }
  plans(options: PlanOptions = {}) {
    parseSort(options.sort);
    return this.#serial(async () => sortPlans(await this.#accounts.plans(options), options.sort));
  }
  subscribe(id: string, category?: number) {
    return this.#serial(() => this.#accounts.subscribe(id, category));
  }
  sendFreeSms(number: string, text: string) {
    return this.#serial(() => this.#accounts.sendFreeSms(number, text));
  }

  async #gameSession(signal?: AbortSignal): Promise<GameSession> {
    signal?.throwIfAborted();
    const identity = await this.#accounts.sessionIdentity();
    signal?.throwIfAborted();
    if (
      !this.#game ||
      this.#game.identity !== identity ||
      Date.now() - this.#game.created >= 600_000 ||
      this.#game.session.tokens === undefined
    ) {
      const encrypted = await this.#accounts.gameIdentity(signal);
      const session = await GameSession.open(encrypted.url, {
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
        ...(this.#options.gameEndpoints ? { endpoints: this.#options.gameEndpoints } : {}),
        ...(signal ? { signal } : {}),
      });
      this.#game = { identity: encrypted.identity, created: Date.now(), session };
    }
    return this.#game.session;
  }

  checkIn() {
    return this.#serial(async () => (await this.#gameSession()).checkIn());
  }
  taskStatus() {
    return this.#serial(async () => (await this.#gameSession()).status());
  }
  ranks() {
    return this.#serial(async () => (await this.#gameSession()).ranks());
  }
  claimTasks(
    ids: number[] | 'all',
    onTask?: (result: Record<string, unknown>) => void | Promise<void>,
  ) {
    return this.#serial(async () => (await this.#gameSession()).claimTasks(ids, onTask));
  }
  spin(options: PlayOptions = {}) {
    return this.#play('spin', options);
  }
  scratch(options: PlayOptions = {}) {
    return this.#play('scratch', options);
  }
  math(options: PlayOptions = {}) {
    return this.#play('math', options);
  }

  #play(kind: GameKind, options: PlayOptions): Promise<PlayResult> {
    // Validate options before loading credentials or making requests.
    const count = parseCount(options.count ?? 1);
    const seconds = parseDelay(options.delay ?? 0);
    return this.#serial(async () => {
      options.signal?.throwIfAborted();
      const session = await this.#gameSession(options.signal);
      if (count === 'all' && session.tokens === undefined) {
        throw new NcellError('Could not read the current game-token balance', {
          code: 'INVALID_RESPONSE',
        });
      }
      const results: Record<string, unknown>[] = [];
      const cost = 25;
      for (let index = 0; count === 'all' || index < count; index++) {
        options.signal?.throwIfAborted();
        if (count === 'all' && session.tokens !== undefined && session.tokens < cost) {
          return { games: results.length, results, stop: 'insufficient_tokens' };
        }
        if (index > 0 && seconds > 0) {
          const until = performance.now() + seconds * 1000;
          while (performance.now() < until) {
            const remaining = (until - performance.now()) / 1000;
            await options.onEvent?.({ event: 'wait', seconds: remaining });
            await delay(Math.min(remaining, 1), options.signal);
          }
          await options.onEvent?.({ event: 'wait', seconds: 0 });
        }
        await options.onEvent?.({
          event: 'game_start',
          game: index + 1,
          kind,
          total:
            count === 'all'
              ? session.tokens === undefined
                ? undefined
                : index + Math.floor(session.tokens / cost)
              : count,
        });
        try {
          const result =
            kind === 'math'
              ? await session.math({
                  onAnswer: async (result) => {
                    await options.onEvent?.({ event: 'answer', game: index + 1, result });
                  },
                  ...(options.manualAnswer ? { manualAnswer: options.manualAnswer } : {}),
                  ...(options.signal ? { signal: options.signal } : {}),
                })
              : await session[kind](options.signal ? { signal: options.signal } : {});
          results.push(result);
          await options.onEvent?.({ event: 'result', game: index + 1, result });
          if (kind === 'math' && result.result !== 'win' && result.win !== true) {
            throw new NcellError('Math game lost', { code: 'GAME_LOST', response: result });
          }
        } catch (error) {
          if (count === 'all' && isInsufficientTokens(error)) {
            return { games: results.length, results, stop: 'insufficient_tokens' };
          }
          throw error;
        }
      }
      return { games: results.length, results, stop: 'count' };
    });
  }
}

export function createNcellApp(options: NcellOptions = {}): NcellApp {
  return new NcellApp(options);
}
