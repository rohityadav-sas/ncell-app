import { randomUUID } from 'node:crypto';
import { NcellError, invalidResponse, object, text } from './error.js';
import type { AccountOptions, JsonObject } from './types.js';
import { responseDescriptions } from './response-codes.js';

export const BASE_URL = 'https://sca.ncell.com.np/adl/et/telco/selfcare/ncell/api';

function networkError(cause: unknown): NcellError {
  const timedOut =
    cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
  return new NcellError(
    timedOut
      ? 'Connection to Ncell timed out; check your connection and try again'
      : 'Network request failed; check your connection and try again',
    { code: timedOut ? 'TIMEOUT' : 'NETWORK', cause },
  );
}

export function requestHeader(msisdn: string, action: string): JsonObject {
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    channel: 'sca',
    deviceType: 'android',
    clientip: 'N/A',
    action,
    msisdn,
    location: 'N/A',
    primaryMsisdn: msisdn,
    languageCode: '1',
  };
}

export class ApiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AccountOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 90_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new NcellError('Request timeout must be a positive integer in milliseconds');
    }
  }

  async post(
    path: string,
    body: JsonObject,
    token?: string,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    signal?.throwIfAborted();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal:
          signal === undefined
            ? AbortSignal.timeout(this.timeoutMs)
            : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        redirect: 'manual',
      });
    } catch (cause) {
      signal?.throwIfAborted();
      throw networkError(cause);
    }
    let value: JsonObject;
    try {
      value = object(await response.json());
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof NcellError) throw cause;
      if (cause instanceof SyntaxError) throw invalidResponse();
      throw networkError(cause);
    }
    signal?.throwIfAborted();
    const header = object(value.responseHeader);
    const success = header.responseCode === '200' || header.responseCode === 200;
    const subscriptionSuccess =
      path === '/v1.0/billingmgt/product/subscribe' && header.responseDescDisplay === 'BIL1000';
    if (!response.ok || (!success && !subscriptionSuccess)) {
      const detail =
        typeof header.responseDescDisplay === 'string' &&
        /^[A-Z]{2,8}\d{4}$/.test(header.responseDescDisplay)
          ? header.responseDescDisplay
          : undefined;
      const rawCode = detail ?? String(header.responseCode ?? 'unknown');
      const code = /^[A-Za-z0-9]{1,32}$/.test(rawCode) ? rawCode : 'unknown';
      const description = Object.hasOwn(responseDescriptions, code)
        ? `: ${responseDescriptions[code]}`
        : '';
      throw new NcellError(
        `Ncell rejected the request (HTTP ${response.status}, code ${code})${description}`,
        {
          code,
          status: response.status,
          response: value,
        },
      );
    }
    return value;
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
}

export function tokens(response: JsonObject): Tokens {
  const body = object(response.validateOTPResponse ?? response.userAuthResponse);
  const result: Tokens = { accessToken: text(body.accessToken) };
  if (typeof body.refreshToken === 'string' && body.refreshToken !== '')
    result.refreshToken = body.refreshToken;
  const expiry = body.expiresIn;
  if (
    typeof expiry === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(expiry)
  ) {
    if (!Number.isNaN(Date.parse(expiry))) result.accessTokenExpiresAt = expiry;
  } else if (
    (typeof expiry === 'number' || typeof expiry === 'string') &&
    /^\d+$/.test(String(expiry))
  ) {
    const seconds = Number(expiry);
    const end = Date.now() + seconds * 1_000;
    if (Number.isSafeInteger(seconds) && end <= 8_640_000_000_000_000)
      result.accessTokenExpiresAt = new Date(end).toISOString();
  }
  return result;
}
