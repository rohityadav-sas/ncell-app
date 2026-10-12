import { parseHTML } from 'linkedom';
import { CookieJar } from 'tough-cookie';
import { NcellError } from '../core/index.js';
import { matchMathAnswer, solveMath } from './math.js';
import { parseRanks } from './ranks.js';

export { evaluateMath, solveMath } from './math.js';
export { parseRanks } from './ranks.js';

type Data = Record<string, unknown>;
export type GameCallback = (result: Data) => void | Promise<void>;

export interface GameTaskResult extends Data {
  id: number;
  response: Data;
}

export interface ClaimTasksResult extends Data {
  results: GameTaskResult[];
  failed: boolean;
}

export interface GameEndpoints {
  status: string;
  ranks: string;
  checkIn: string;
  claimTask: string;
  spin: string;
  scratch: string;
  math: string;
}

export interface GameRequestOptions {
  signal?: AbortSignal;
}

export interface GameSessionOptions extends GameRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  endpoints?: Partial<GameEndpoints>;
}

export interface MathOptions extends GameRequestOptions {
  onAnswer?: GameCallback;
  manualAnswer?: (question: Data) => Promise<string>;
}

const base = 'https://sajeeb.com.np/ncellapp/checkin';
const endpoints: GameEndpoints = {
  status: `${base}/api/challenge_status.php`,
  ranks: `${base}/ranks.php`,
  checkIn: `${base}/api/checkin.php`,
  claimTask: `${base}/api/record_activity.php`,
  spin: `${base}/fetchSpinReward.php`,
  scratch: `${base}/fetchScratchReward.php`,
  math: `${base}/math_challenge_api.php`,
};

function object(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenBalance(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function message(data: Data, fallback = 'Game request failed'): string {
  return typeof data.message === 'string'
    ? data.message
    : typeof data.error === 'string'
      ? data.error
      : fallback;
}

export function alreadyClaimed(data: Data): boolean {
  return ['Task already completed today', 'Reward already claimed'].includes(
    typeof data.error === 'string'
      ? data.error
      : typeof data.message === 'string'
        ? data.message
        : '',
  );
}

export function alreadyCheckedIn(data: Data): boolean {
  return message(data, '').toLowerCase().includes('already checked');
}

export function isInsufficientTokens(error: unknown): boolean {
  return (
    error instanceof NcellError &&
    error.status === 200 &&
    ['insufficient tokens', 'not enough points', 'low_balance'].includes(
      error.message.trim().toLowerCase(),
    )
  );
}

/** One website bootstrap, cookie jar and CSRF token reused for sequential game requests. */
export class GameSession {
  public tokens: number | undefined;
  private readonly jar = new CookieJar();
  private csrf = '';
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly endpoints: GameEndpoints;

  private constructor(options: GameSessionOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new NcellError('Request timeout must be a positive integer');
    }
    this.endpoints = { ...endpoints, ...options.endpoints };
  }

  static async open(url: string, options: GameSessionOptions = {}): Promise<GameSession> {
    const session = new GameSession(options);
    const page = await session.request(url, {
      headers: { 'User-Agent': 'wv' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!page.ok) throw session.error({}, page.status, 'Check-in website rejected the request');
    let html: string;
    try {
      html = await page.text();
    } catch (cause) {
      options.signal?.throwIfAborted();
      throw new NcellError('Game request could not be completed', { code: 'NETWORK_ERROR', cause });
    }
    options.signal?.throwIfAborted();
    const { document } = parseHTML(html);
    session.csrf = document.querySelector('input[name="csrf_token"]')?.getAttribute('value') ?? '';
    const balance = document
      .querySelector('#tokens-display')
      ?.textContent?.trim()
      .replaceAll(',', '');
    if (balance && /^\d+$/.test(balance)) session.tokens = tokenBalance(Number(balance));
    return session;
  }

  private requireCsrf(): void {
    if (!this.csrf) throw new NcellError('Check-in page did not provide a CSRF token');
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const caller = init.signal ?? undefined;
    caller?.throwIfAborted();
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new NcellError('Game requests require an HTTP or HTTPS URL');
    }
    const headers = new Headers(init.headers);
    const cookie = await this.jar.getCookieString(target.href);
    if (cookie) headers.set('Cookie', cookie);
    caller?.throwIfAborted();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      response = await this.fetcher(target.href, {
        ...init,
        headers,
        redirect: 'manual',
        signal: caller ? AbortSignal.any([caller, timeout]) : timeout,
      });
    } catch (cause) {
      // A dispatched reward request may have changed the server balance before cancellation.
      if (init.method === 'POST') this.tokens = undefined;
      caller?.throwIfAborted();
      throw new NcellError('Game request could not be completed', { code: 'NETWORK_ERROR', cause });
    }
    for (const value of response.headers.getSetCookie()) {
      await this.jar.setCookie(value, target.href, { ignoreError: true });
    }
    if (caller?.aborted && init.method === 'POST') this.tokens = undefined;
    caller?.throwIfAborted();
    return response;
  }

  private error(data: Data, status: number, fallback?: string): NcellError {
    return new NcellError(message(data, fallback), { code: 'GAME_ERROR', status, response: data });
  }

  private async decode(
    response: Response,
    kind: 'standard' | 'reward' | 'math',
    signal?: AbortSignal,
  ): Promise<Data> {
    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      // The server may have spent tokens even if its response cannot be read.
      this.tokens = undefined;
      signal?.throwIfAborted();
      if (!(cause instanceof SyntaxError)) {
        throw new NcellError('Game request could not be completed', {
          code: 'NETWORK_ERROR',
          cause,
        });
      }
      if (!response.ok) {
        throw this.error({}, response.status, 'Game website rejected the request');
      }
      throw new NcellError('Ncell returned an invalid game response', {
        code: 'INVALID_RESPONSE',
        status: response.status,
        cause,
      });
    }
    if (signal?.aborted) this.tokens = undefined;
    signal?.throwIfAborted();
    if (!object(data)) {
      this.tokens = undefined;
      throw new NcellError('Ncell returned an invalid game response', {
        code: 'INVALID_RESPONSE',
        status: response.status,
        response: data,
      });
    }
    const success =
      kind === 'standard'
        ? data.success === true
        : kind === 'math'
          ? data.success !== false && data.error == null
          : typeof data.value === 'string' &&
            (tokenBalance(data.new_token_balance) !== undefined ||
              tokenBalance(data.points_remaining) !== undefined) &&
            typeof data.new_week_points === 'number' &&
            data.error == null &&
            data.success !== false;
    if (!response.ok || !success) throw this.error(data, response.status);
    return data;
  }

  private form(fields: Record<string, string>): URLSearchParams {
    return new URLSearchParams(fields);
  }

  async status(): Promise<Data> {
    return this.decode(
      await this.request(this.endpoints.status, { headers: { 'User-Agent': 'wv' } }),
      'standard',
    );
  }

  async ranks(): Promise<Data> {
    const response = await this.request(this.endpoints.ranks, { headers: { 'User-Agent': 'wv' } });
    if (!response.ok) throw this.error({}, response.status, 'Leaderboard request failed');
    return parseRanks(await response.text());
  }

  private async claim(endpoint: string, activityId?: number): Promise<Data> {
    this.requireCsrf();
    return this.decode(
      await this.request(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': 'wv' },
        body: this.form({
          csrf_token: this.csrf,
          ...(activityId === undefined ? {} : { activity_id: String(activityId) }),
        }),
      }),
      'standard',
    );
  }

  async checkIn(): Promise<Data> {
    let data: Data;
    try {
      data = await this.claim(this.endpoints.checkIn);
    } catch (error) {
      if (
        !(error instanceof NcellError) ||
        !object(error.response) ||
        !alreadyCheckedIn(error.response)
      )
        throw error;
      return error.response;
    }
    if (!alreadyCheckedIn(data))
      this.tokens = object(data.data) ? tokenBalance(data.data.game_tokens) : undefined;
    return data;
  }

  async claimTasks(ids: number[] | 'all', onTask?: GameCallback): Promise<ClaimTasksResult> {
    let activities: number[];
    if (ids === 'all') {
      const status = await this.status();
      if (!Array.isArray(status.challenges) || !status.challenges.every(object)) {
        throw new NcellError('Ncell returned invalid game tasks', { code: 'INVALID_RESPONSE' });
      }
      activities = status.challenges
        .filter(
          (task) =>
            (task.completed === true || task.completed === 1) &&
            (task.rewarded === false || task.rewarded === 0),
        )
        .map((task) => {
          const id =
            typeof task.id === 'number'
              ? task.id
              : typeof task.id === 'string' && /^\d+$/.test(task.id)
                ? Number(task.id)
                : NaN;
          if (!Number.isSafeInteger(id) || id <= 0)
            throw new NcellError('Ncell returned an invalid task ID', { code: 'INVALID_RESPONSE' });
          return id;
        });
    } else {
      if (!ids.every((id) => Number.isSafeInteger(id) && id > 0))
        throw new NcellError('Task IDs must be positive integers');
      activities = ids;
    }
    const results: GameTaskResult[] = [];
    let failed = false;
    for (const id of activities) {
      let response: Data;
      let rejected = false;
      try {
        response = await this.claim(this.endpoints.claimTask, id);
      } catch (error) {
        if (
          !(error instanceof NcellError) ||
          error.code !== 'GAME_ERROR' ||
          !object(error.response)
        )
          throw error;
        response = error.response;
        rejected = true;
      }
      const already = alreadyClaimed(response);
      if (!already) this.tokens = tokenBalance(response.new_token_balance);
      failed ||= (rejected || response.success !== true) && !already;
      const result = { id, response };
      results.push(result);
      await onTask?.(result);
    }
    return { results, failed };
  }

  async spin(options: GameRequestOptions = {}): Promise<Data> {
    this.requireCsrf();
    const data = await this.decode(
      await this.request(this.endpoints.spin, {
        method: 'POST',
        body: this.form({ csrf_token: this.csrf }),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      'reward',
      options.signal,
    );
    this.tokens = tokenBalance(data.new_token_balance) ?? tokenBalance(data.points_remaining);
    return data;
  }

  async scratch(options: GameRequestOptions = {}): Promise<Data> {
    this.requireCsrf();
    const data = await this.decode(
      await this.request(this.endpoints.scratch, {
        method: 'POST',
        body: new URLSearchParams({ csrf_token: this.csrf }),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      'reward',
      options.signal,
    );
    this.tokens = tokenBalance(data.points_remaining) ?? tokenBalance(data.new_token_balance);
    return data;
  }

  private async mathRequest(action: string, answer?: string, signal?: AbortSignal): Promise<Data> {
    return this.decode(
      await this.request(this.endpoints.math, {
        method: 'POST',
        body: this.form({
          action,
          csrf_token: this.csrf,
          ...(answer === undefined ? {} : { answer }),
        }),
        ...(signal ? { signal } : {}),
      }),
      'math',
      signal,
    );
  }

  async math(options: MathOptions = {}): Promise<Data> {
    this.requireCsrf();
    const start = await this.mathRequest('start_game', undefined, options.signal);
    if (start.success !== true)
      throw new NcellError('Ncell returned an invalid math start', {
        code: 'INVALID_RESPONSE',
        response: start,
      });
    // bg_reward is unrelated to game tokens. Preserve the same fixed entry fee as the CLI.
    if (this.tokens !== undefined) this.tokens = Math.max(0, this.tokens - 25);
    for (let index = 0; index < 60; index++) {
      const question = await this.mathRequest('get_question', undefined, options.signal);
      if (question.win === true || question.game_over === true) return question;
      let answer: string;
      try {
        answer = solveMath(question);
      } catch (error) {
        if (!(error instanceof NcellError) || error.code !== 'UNSUPPORTED_MATH') throw error;
        const manualAnswer = options.manualAnswer;
        if (!manualAnswer) {
          throw new NcellError('Math question requires a manual answer', {
            code: 'MANUAL_ANSWER_REQUIRED',
            response: question,
          });
        }
        const input = (await withSignal(() => manualAnswer(question), options.signal)).trim();
        if (!input || !Number.isFinite(Number(input)))
          throw new NcellError('Math answer must be a finite number');
        answer = matchMathAnswer(question, Number(input));
      }
      const response = await this.mathRequest('submit_answer', answer, options.signal);
      await withSignal(
        () =>
          options.onAnswer?.({
            level: question.level,
            question: question.question,
            answer,
            response,
          }),
        options.signal,
      );
      if (['win', 'game_over', 'lose'].includes(String(response.result))) return response;
      if (response.result !== 'correct' && response.result !== 'wrong') {
        throw new NcellError('Ncell returned an invalid math result', {
          code: 'INVALID_RESPONSE',
          response,
        });
      }
    }
    throw new NcellError('Math game exceeded the expected number of questions', {
      code: 'INVALID_RESPONSE',
    });
  }
}

async function withSignal<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', rejectAbort);
  }
}
