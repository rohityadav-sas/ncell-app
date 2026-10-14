import { GAME_BASE_URL } from './endpoints.js';
import { DEFAULT_PLAN_CATEGORY } from './catalog.js';
import { createHash, randomBytes } from 'node:crypto';
import { ApiClient, requestHeader, tokens } from './http.js';
import { NcellError, invalidResponse, normalizeNumber, object, text } from './error.js';
import { NativeSessionStore } from './storage.js';
import type {
  Account,
  AccountOptions,
  AccountStatus,
  AccountSummary,
  JsonObject,
  SavedAccount,
  Session,
  SessionStore,
} from './types.js';

const CATEGORY_TTL = 600_000;

function notLoggedIn(): NcellError {
  return new NcellError('No saved account. Run `ncell login <number>`', { code: 'NOT_LOGGED_IN' });
}

function active(session: Session | undefined): { session: Session; account: Account } {
  if (session?.account === undefined || session.deviceId === '') throw notLoggedIn();
  return { session, account: session.account };
}

function identity(session: Session, account: Account): string {
  return createHash('sha256')
    .update(JSON.stringify([account.msisdn, session.deviceId, account.accessToken]))
    .digest('hex');
}

function select(session: Session, account: Account): void {
  session.otherAccounts = session.otherAccounts.filter(
    (saved) => saved.account.msisdn !== account.msisdn,
  );
  if (session.account !== undefined && session.account.msisdn !== account.msisdn) {
    session.otherAccounts.push({ deviceId: session.deviceId, account: session.account });
  }
  session.account = account;
  delete session.pendingMsisdn;
}

function logout(session: Session): void {
  delete session.account;
  delete session.pendingMsisdn;
  const next = session.otherAccounts.pop();
  session.deviceId = next?.deviceId ?? '';
  if (next !== undefined) session.account = next.account;
}

/** Reusable authenticated Ncell API. Methods never prompt or write terminal output. */
export class AccountService {
  readonly store: SessionStore;
  private readonly api: ApiClient;
  private readonly categoriesCache = new Map<string, { savedAt: number; response: JsonObject }>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: AccountOptions = {}) {
    this.store = options.store ?? new NativeSessionStore();
    this.api = new ApiClient(options);
  }

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.store.withLock !== undefined) return this.store.withLock(operation);
    const previous = this.tail;
    let done = (): void => {};
    this.tail = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      done();
    }
  }

  private async authenticated<T>(
    request: (account: Account, session: Session) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    return this.transaction(async () => {
      signal?.throwIfAborted();
      let current = active(await this.store.load());
      signal?.throwIfAborted();
      try {
        return await request(current.account, current.session);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof NcellError) || error.status !== 401 || error.code !== 'LGN2001')
          throw error;
        await this.rotate(current.session, signal);
        current = active(await this.store.load());
        signal?.throwIfAborted();
        return request(current.account, current.session);
      }
    });
  }

  async requestOtp(input: string): Promise<{ otpRequested: true; msisdn: string }> {
    const msisdn = normalizeNumber(input);
    return this.transaction(async () => {
      const session = (await this.store.load()) ?? { deviceId: '', otherAccounts: [] };
      if (session.deviceId === '') session.deviceId = randomBytes(8).toString('hex');
      session.pendingMsisdn = msisdn;
      // Persist the binding before the SMS request, including failed or cancelled requests.
      await this.store.save(session);
      await this.api.post('/v1.0/user/otp/generate', {
        generateOTPRequest: { msisdn, deviceId: session.deviceId, action: 'LOGIN' },
        requestHeader: requestHeader(msisdn, 'LOGIN'),
      });
      return { otpRequested: true, msisdn };
    });
  }

  async verifyOtp(
    input: string,
    otp: string,
    options: { activate?: boolean } = {},
  ): Promise<{ loggedIn: true; msisdn: string; active: boolean }> {
    const msisdn = normalizeNumber(input);
    if (!/^\d{4,8}$/.test(otp)) throw new NcellError('OTP must contain 4 to 8 digits');
    return this.transaction(async () => {
      const session = await this.store.load();
      if (session === undefined || session.pendingMsisdn !== msisdn || session.deviceId === '') {
        throw new NcellError('No pending OTP for this number; run `ncell login <number>` first', {
          code: 'NO_PENDING_LOGIN',
        });
      }
      const fresh = tokens(
        await this.api.post('/v1.0/user/otp/validate', {
          validateOTPRequest: {
            msisdn,
            deviceId: session.deviceId,
            otpDetail: { action: 'LOGIN', otp },
          },
          requestHeader: requestHeader(msisdn, 'LOGIN'),
        }),
      );
      const now = new Date().toISOString();
      const account: Account = { msisdn, ...fresh, authenticatedAt: now, tokenSavedAt: now };
      if (options.activate !== false) select(session, account);
      else {
        if (session.account?.msisdn === msisdn) session.account = account;
        else {
          session.otherAccounts = session.otherAccounts.filter(
            (saved) => saved.account.msisdn !== msisdn,
          );
          session.otherAccounts.push({ deviceId: session.deviceId, account });
        }
        delete session.pendingMsisdn;
      }
      await this.store.save(session);
      return { loggedIn: true, msisdn, active: session.account?.msisdn === msisdn };
    });
  }

  private async rotate(session: Session, signal?: AbortSignal): Promise<void> {
    const { account } = active(session);
    if (account.refreshToken === undefined || account.refreshToken === '') {
      throw new NcellError('No refresh token saved. Log in again');
    }
    const fresh = tokens(
      await this.api.post(
        '/v1.0/user/refresh/token',
        {
          refreshTokenRequest: { refreshToken: account.refreshToken },
          requestHeader: {
            ...requestHeader(account.msisdn, 'LOGOUT_ACTION'),
            deviceId: session.deviceId,
          },
        },
        undefined,
        signal,
      ),
    );
    account.accessToken = fresh.accessToken;
    if (fresh.refreshToken !== undefined) account.refreshToken = fresh.refreshToken;
    account.tokenSavedAt = new Date().toISOString();
    if (fresh.accessTokenExpiresAt === undefined) delete account.accessTokenExpiresAt;
    else account.accessTokenExpiresAt = fresh.accessTokenExpiresAt;
    await this.store.save(session);
  }

  async refresh(): Promise<{ refreshed: true }> {
    return this.transaction(async () => {
      const { session } = active(await this.store.load());
      await this.rotate(session);
      return { refreshed: true };
    });
  }

  async status(): Promise<AccountStatus> {
    const session = await this.store.load();
    if (session?.account === undefined) return {};
    const account = session.account;
    const result: AccountStatus = {
      account: account.msisdn,
      authenticatedAt: account.authenticatedAt,
    };
    if (account.tokenSavedAt !== undefined) result.tokenSavedAt = account.tokenSavedAt;
    if (account.accessTokenExpiresAt !== undefined)
      result.accessTokenExpiresAt = account.accessTokenExpiresAt;
    return result;
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const session = await this.store.load();
    if (session === undefined) return [];
    return [
      ...(session.account === undefined ? [] : [{ msisdn: session.account.msisdn, active: true }]),
      ...session.otherAccounts.map((saved) => ({ msisdn: saved.account.msisdn, active: false })),
    ];
  }

  async switchAccount(input: string): Promise<{ switched: true; msisdn: string }> {
    const msisdn = normalizeNumber(input);
    return this.transaction(async () => {
      const session = await this.store.load();
      if (session?.account?.msisdn === msisdn) return { switched: true, msisdn };
      const index =
        session?.otherAccounts.findIndex((saved) => saved.account.msisdn === msisdn) ?? -1;
      if (session === undefined || index === -1)
        throw new NcellError('Account is not saved. Log in to it first');
      const incoming = session.otherAccounts.splice(index, 1)[0] as SavedAccount;
      select(session, incoming.account);
      session.deviceId = incoming.deviceId;
      await this.store.save(session);
      return { switched: true, msisdn };
    });
  }

  private async saveRemaining(session: Session): Promise<void> {
    if (
      session.account === undefined &&
      session.otherAccounts.length === 0 &&
      session.pendingMsisdn === undefined
    )
      await this.store.clear();
    else await this.store.save(session);
  }

  async removeAccount(input: string): Promise<{ removed: true; msisdn: string }> {
    const msisdn = normalizeNumber(input);
    return this.transaction(async () => {
      const session = await this.store.load();
      if (session === undefined) throw new NcellError('Account is not saved');
      if (session.account?.msisdn === msisdn) logout(session);
      else {
        const index = session.otherAccounts.findIndex((saved) => saved.account.msisdn === msisdn);
        if (index === -1) throw new NcellError('Account is not saved');
        session.otherAccounts.splice(index, 1);
        if (session.pendingMsisdn === msisdn) delete session.pendingMsisdn;
      }
      await this.saveRemaining(session);
      return { removed: true, msisdn };
    });
  }

  async logout(): Promise<{ loggedOut: true }> {
    return this.transaction(async () => {
      let session: Session | undefined;
      try {
        session = await this.store.load();
      } catch (error) {
        if (error instanceof NcellError && error.code === 'INVALID_SESSION') {
          await this.store.clear();
          return { loggedOut: true };
        }
        throw error;
      }
      if (session !== undefined) {
        logout(session);
        await this.saveRemaining(session);
      }
      return { loggedOut: true };
    });
  }

  async balance(): Promise<JsonObject> {
    return this.authenticated(async (account) =>
      object(
        (
          await this.api.post(
            '/v1.0/accountmgt/balance/query',
            {
              queryBalanceRequest: { msisdn: account.msisdn },
              requestHeader: requestHeader(account.msisdn, 'MY_SERVICES'),
            },
            account.accessToken,
          )
        ).queryBalanceResponse,
      ),
    );
  }

  async profile(): Promise<JsonObject> {
    return this.authenticated(async (account) =>
      object(
        (
          await this.api.post(
            '/v1.0/subscriber/profile/query',
            {
              querySubscriberProfileRequest: {},
              requestHeader: { ...requestHeader(account.msisdn, 'PROFILE'), appVersion: '8.2.1.0' },
            },
            account.accessToken,
          )
        ).querySubscriberProfileResponse,
      ),
    );
  }

  private async getCategories(account: Account): Promise<JsonObject> {
    const cached = this.categoriesCache.get(account.msisdn);
    if (cached !== undefined && Date.now() - cached.savedAt < CATEGORY_TTL)
      return structuredClone(cached.response);
    const response = await this.api.post(
      '/v1.0/product-catalog/tags',
      { requestHeader: requestHeader(account.msisdn, 'N/A') },
      account.accessToken,
    );
    if (!Array.isArray(response.tags)) throw invalidResponse();
    this.categoriesCache.set(account.msisdn, {
      savedAt: Date.now(),
      response: structuredClone(response),
    });
    return response;
  }

  async categories(): Promise<JsonObject> {
    return this.authenticated((account) => this.getCategories(account));
  }

  private async getPlans(account: Account, category: number, keyword: string): Promise<JsonObject> {
    let catalog = 'data';
    if (category !== DEFAULT_PLAN_CATEGORY) {
      const tags = (await this.getCategories(account)).tags as unknown[];
      const tag = tags.map(object).find((item) => item.id === category);
      if (tag === undefined || !Array.isArray(tag.categories))
        throw new NcellError('Unknown category. Use ncell plans categories');
      const kinds = tag.categories.map(object);
      const selected = [
        ['GSM_DATA', 'data'],
        ['GSM_VOICE', 'voice'],
        ['GSM_SMS', 'sms'],
      ].find(([kind]) => kinds.some((item) => item.name === kind));
      if (selected?.[1] === undefined) throw new NcellError('Unsupported category type');
      catalog = selected[1];
    }
    const body: JsonObject = {
      msisdn: account.msisdn,
      languageCode: '1',
      tagId: category,
      sortby: { name: 'price', isDescending: false },
      requestHeader: requestHeader(account.msisdn, 'SHOP'),
    };
    if (keyword !== '') body.keyword = keyword;
    const response = await this.api.post(
      `/v1.0/product/${catalog}-plans`,
      body,
      account.accessToken,
    );
    if (!Array.isArray(response.availablePackages)) throw invalidResponse();
    return response;
  }

  async plans(options: { category?: number; keyword?: string } = {}): Promise<JsonObject> {
    const category = options.category ?? DEFAULT_PLAN_CATEGORY;
    if (!Number.isSafeInteger(category) || category < 0)
      throw new NcellError('Category must be a nonnegative integer');
    return this.authenticated((account) => this.getPlans(account, category, options.keyword ?? ''));
  }

  async subscribe(id: string, category = DEFAULT_PLAN_CATEGORY): Promise<JsonObject> {
    if (id.trim() === '') throw new NcellError('Plan ID cannot be empty');
    if (!Number.isSafeInteger(category) || category < 0)
      throw new NcellError('Category must be a nonnegative integer');
    return this.authenticated(async (account, session) => {
      const plans = (await this.getPlans(account, category, '')).availablePackages as unknown[];
      const plan = plans.map(object).find((item) => String(item.id) === id);
      if (plan === undefined)
        throw new NcellError(
          'Plan not found in this category. Use ncell plans to list available plans',
        );
      const subscriptionCode = text(object(plan.techInfo).subscriptionCode);
      const name = text(plan.ncellName);
      const price = object(plan.productOfferingPrice).price;
      if (typeof price !== 'string') throw invalidResponse();
      const response = await this.api.post(
        '/v1.0/billingmgt/product/subscribe',
        {
          productSubscriptionSummaryRequest: {
            deviceId: session.deviceId,
            msisdn: account.msisdn,
            subscriptionCode,
            productName: name,
            productPrice: price,
            ncellProductName: name,
            medium: 'APP',
            linkId: '00000000000000000',
            termCode: 0,
            useCoupon: false,
            deeplinkClickId: '',
          },
          requestHeader: {
            ...requestHeader(account.msisdn, 'SUBSCRIBE'),
            deviceId: session.deviceId,
            appVersion: '8.2.1.0',
          },
        },
        account.accessToken,
      );
      const header = object(response.responseHeader);
      const result = response.productSubscriptionSummaryResponse;
      if (
        header.responseDescDisplay !== 'BIL1000' &&
        (result === undefined || String(object(result).status).toLowerCase() !== 'success')
      )
        throw invalidResponse();
      return response;
    });
  }

  async sendFreeSms(input: string, content: string): Promise<JsonObject> {
    const destination = normalizeNumber(input);
    if (content.trim() === '') throw new NcellError('SMS text cannot be empty');
    return this.authenticated(async (account) => {
      const response = await this.api.post(
        '/v1.0/smsmgt/free/sms/send',
        {
          sendSMSFreeRequest: { destination, content, isConfirm: 0 },
          requestHeader: requestHeader(account.msisdn, 'MY_SERVICES'),
        },
        account.accessToken,
      );
      if (object(response.sendFreeSMSResponse).status !== 'success') throw invalidResponse();
      return response;
    });
  }

  async sessionIdentity(): Promise<string> {
    const current = active(await this.store.load());
    return identity(current.session, current.account);
  }

  async gameIdentity(signal?: AbortSignal): Promise<{ url: string; identity: string }> {
    return this.authenticated(async (account, session) => {
      const response = await this.api.post(
        '/v1.0/utilitymgt/third-party-encryption',
        {
          thirdPartyClientRequest: { clientId: '47c0b8f2-1766-c12a-5c88-519e40af83b4' },
          requestHeader: { msisdn: account.msisdn },
        },
        account.accessToken,
        signal,
      );
      const encrypted = text(object(response.encryptionResponse).msisdn);
      if (!/^[A-Za-z0-9%._~-]+$/.test(encrypted)) throw invalidResponse();
      return {
        url: `${GAME_BASE_URL}/index.php?MSISDN=${encrypted}`,
        identity: identity(session, account),
      };
    }, signal);
  }
}
