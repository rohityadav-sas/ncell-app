import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { NcellError, normalizeNumber, object, text } from './error.js';
import type { Account, SavedAccount, Session, SessionStore } from './types.js';

class TransactionQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<boolean>();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const previous = this.tail;
    let finish = (): void => {};
    this.tail = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await previous;
    try {
      return await this.context.run(true, operation);
    } finally {
      finish();
    }
  }
}

/** An isolated, clone-on-read store for embedding and tests. It never writes to disk. */
export class MemorySessionStore implements SessionStore {
  private session: Session | undefined;
  private readonly queue = new TransactionQueue();

  constructor(session?: Session) {
    this.session = session === undefined ? undefined : structuredClone(session);
  }

  async load(): Promise<Session | undefined> {
    return this.withLock(async () =>
      this.session === undefined ? undefined : structuredClone(this.session),
    );
  }

  async save(session: Session): Promise<void> {
    await this.withLock(async () => {
      this.session = structuredClone(session);
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      this.session = undefined;
    });
  }

  withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(operation);
  }
}

/** Injectable native credential adapter; useful for an alternative secure store. */
export interface CredentialBackend {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface NativeStoreOptions {
  service?: string;
  backend?: CredentialBackend;
  lockDirectory?: string;
}

interface SessionIndex {
  storageVersion: 1;
  deviceId: string;
  pendingMsisdn?: string;
  activeMsisdn?: string;
  savedAccounts: string[];
}

function storageError(cause?: unknown): NcellError {
  return new NcellError(
    'Credential storage is unavailable or locked; unlock your system keyring and retry',
    {
      code: 'STORAGE',
      cause,
    },
  );
}

function invalidSession(): NcellError {
  return new NcellError('Saved session is invalid; remove the affected account and log in again', {
    code: 'INVALID_SESSION',
  });
}

function decode(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value));
  } catch {
    throw invalidSession();
  }
}

function accountFrom(value: unknown): Account {
  try {
    const raw = object(value);
    const account: Account = {
      msisdn: normalizeNumber(text(raw.msisdn)),
      accessToken: text(raw.accessToken),
      authenticatedAt: text(raw.authenticatedAt),
    };
    if (account.msisdn !== raw.msisdn) throw invalidSession();
    if (Number.isNaN(Date.parse(account.authenticatedAt))) throw invalidSession();
    for (const key of ['refreshToken', 'tokenSavedAt', 'accessTokenExpiresAt'] as const) {
      if (raw[key] !== undefined) account[key] = text(raw[key]);
    }
    return account;
  } catch {
    throw invalidSession();
  }
}

function indexFrom(value: string): SessionIndex {
  try {
    return readIndex(value);
  } catch {
    throw invalidSession();
  }
}

function readIndex(value: string): SessionIndex {
  const raw = decode(value);
  if (
    raw.storageVersion !== 1 ||
    typeof raw.deviceId !== 'string' ||
    !Array.isArray(raw.savedAccounts)
  )
    throw invalidSession();
  const savedAccounts = raw.savedAccounts.map((number: unknown) => {
    if (typeof number !== 'string' || normalizeNumber(number) !== number) throw invalidSession();
    return number;
  });
  if (new Set(savedAccounts).size !== savedAccounts.length) throw invalidSession();
  const index: SessionIndex = { storageVersion: 1, deviceId: raw.deviceId, savedAccounts };
  if (raw.pendingMsisdn !== undefined)
    index.pendingMsisdn = normalizeNumber(text(raw.pendingMsisdn));
  if (raw.activeMsisdn !== undefined) {
    index.activeMsisdn = normalizeNumber(text(raw.activeMsisdn));
    if (!savedAccounts.includes(index.activeMsisdn) || index.deviceId === '')
      throw invalidSession();
  }
  return index;
}

/** OS-native secure credentials, split per account to fit Windows credential limits. */
export class NativeSessionStore implements SessionStore {
  readonly service: string;
  private readonly queue = new TransactionQueue();
  private readonly held = new AsyncLocalStorage<boolean>();
  private readonly options: NativeStoreOptions;
  private backend: CredentialBackend | undefined;

  constructor(options: NativeStoreOptions | string = {}) {
    this.options = typeof options === 'string' ? { service: options } : options;
    this.service = this.options.service ?? 'ncell-app';
    if (!/^[A-Za-z0-9-]+$/.test(this.service))
      throw new NcellError('Invalid credential service name');
    this.backend = this.options.backend;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.held.getStore()) return operation();
    return this.queue.run(async () => {
      const user = createHash('sha256').update(userInfo().username).digest('hex').slice(0, 16);
      const directory = this.options.lockDirectory ?? join(tmpdir(), `ncell-app-${user}`);
      const target = join(directory, this.service);
      let release: (() => Promise<void>) | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await (await open(target, 'a', 0o600)).close();
        release = await lockfile.lock(target, {
          realpath: false,
          retries: 0,
          stale: 120_000,
          update: 10_000,
        });
      } catch (cause) {
        if (cause instanceof Error && 'code' in cause && cause.code === 'ELOCKED') {
          throw new NcellError(
            'Another command is using the saved accounts. Wait for it to finish and retry',
            { code: 'SESSION_BUSY' },
          );
        }
        throw storageError(cause);
      }
      try {
        return await this.held.run(true, operation);
      } finally {
        await release();
      }
    });
  }

  private async credentials(): Promise<CredentialBackend> {
    if (this.backend) return this.backend;
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const entry = (name: string): InstanceType<typeof AsyncEntry> =>
        new AsyncEntry(this.service, name, { linux: { store: 'secret-service' } });
      // Store JSON as UTF-8 bytes: UTF-16 passwords halve Windows' blob capacity.
      const prefix = Buffer.from('ncell-app:1\n', 'utf8');
      this.backend = {
        get: async (name) => {
          const secret = await entry(name).getSecret();
          if (secret === null) return null;
          const bytes = Buffer.from(secret);
          if (!bytes.subarray(0, prefix.length).equals(prefix)) throw invalidSession();
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(prefix.length));
        },
        set: (name, value) =>
          entry(name).setSecret(Buffer.concat([prefix, Buffer.from(value, 'utf8')])),
        delete: async (name) => {
          await entry(name).deleteCredential();
        },
      };
      return this.backend;
    } catch (cause) {
      throw storageError(cause);
    }
  }

  private async native<T>(operation: (backend: CredentialBackend) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.credentials());
    } catch (cause) {
      if (cause instanceof NcellError) throw cause;
      throw storageError(cause);
    }
  }

  async load(): Promise<Session | undefined> {
    return this.withLock(() =>
      this.native(async (backend) => {
        const encoded = await backend.get('session');
        if (encoded === null) return undefined;
        const index = indexFrom(encoded);
        const session: Session = { deviceId: index.deviceId, otherAccounts: [] };
        if (index.pendingMsisdn !== undefined) session.pendingMsisdn = index.pendingMsisdn;
        for (const number of index.savedAccounts) {
          const value = await backend.get(`account-${number}`);
          if (value === null) throw invalidSession();
          const raw = decode(value);
          if (typeof raw.deviceId !== 'string' || raw.deviceId === '') throw invalidSession();
          const saved: SavedAccount = { deviceId: raw.deviceId, account: accountFrom(raw.account) };
          if (saved.account.msisdn !== number) throw invalidSession();
          if (number === index.activeMsisdn) {
            if (saved.deviceId !== index.deviceId) throw invalidSession();
            session.account = saved.account;
          } else session.otherAccounts.push(saved);
        }
        return session;
      }),
    );
  }

  async save(session: Session): Promise<void> {
    await this.withLock(() =>
      this.native(async (backend) => {
        const previous = await backend.get('session');
        const previousIndex = previous === null ? undefined : indexFrom(previous);
        if (typeof session.deviceId !== 'string' || !Array.isArray(session.otherAccounts))
          throw invalidSession();
        const supplied: SavedAccount[] =
          session.account === undefined
            ? [...session.otherAccounts]
            : [{ deviceId: session.deviceId, account: session.account }, ...session.otherAccounts];
        // Validate the entire session before writing any account entry.
        const accounts = supplied.map((saved) => {
          if (typeof saved.deviceId !== 'string' || saved.deviceId === '') throw invalidSession();
          return { deviceId: saved.deviceId, account: accountFrom(saved.account) };
        });
        const numbers = accounts.map((saved) => saved.account.msisdn);
        if (new Set(numbers).size !== numbers.length) throw invalidSession();
        const index: SessionIndex = {
          storageVersion: 1,
          deviceId: session.deviceId,
          savedAccounts: numbers,
        };
        if (session.account !== undefined) index.activeMsisdn = session.account.msisdn;
        if (session.pendingMsisdn !== undefined)
          index.pendingMsisdn = normalizeNumber(session.pendingMsisdn);
        for (const saved of accounts) {
          await this.writeVerified(
            backend,
            `account-${saved.account.msisdn}`,
            JSON.stringify(saved),
          );
        }
        await this.writeVerified(backend, 'session', JSON.stringify(index));
        for (const old of previousIndex?.savedAccounts ?? []) {
          if (!numbers.includes(old)) await backend.delete(`account-${old}`);
        }
      }),
    );
  }

  private async writeVerified(
    backend: CredentialBackend,
    name: string,
    value: string,
  ): Promise<void> {
    if ((await backend.get(name)) === value) return;
    await backend.set(name, value);
    if ((await backend.get(name)) !== value) throw storageError();
  }

  async clear(): Promise<void> {
    await this.withLock(() =>
      this.native(async (backend) => {
        const encoded = await backend.get('session');
        if (encoded !== null) {
          const index = indexFrom(encoded);
          await backend.delete('session');
          for (const number of index.savedAccounts) await backend.delete(`account-${number}`);
        }
      }),
    );
  }
}
