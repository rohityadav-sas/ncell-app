import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { MemorySessionStore, NativeSessionStore, NcellError } from '../src/core/index.js';
import type { Session } from '../src/core/index.js';
import type { CredentialBackend } from '../src/core/storage.js';

class Backend implements CredentialBackend {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  readonly deletions: string[] = [];
  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.writes.push(name);
    this.values.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.deletions.push(name);
    this.values.delete(name);
  }
}

function session(): Session {
  return {
    deviceId: 'first-device',
    account: {
      msisdn: '9812345678',
      accessToken: 'a'.repeat(2000),
      refreshToken: 'r'.repeat(2000),
      authenticatedAt: '2026-10-13T00:00:00Z',
    },
    otherAccounts: [
      {
        deviceId: 'second-device',
        account: {
          msisdn: '9823456789',
          accessToken: 'other',
          authenticatedAt: '2026-10-12T00:00:00Z',
        },
      },
    ],
  };
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ncell-app-storage-test-'));
}
async function cleanup(path: string): Promise<void> {
  assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep));
  assert.ok(path.includes('ncell-app-storage-test-'));
  await rm(path, { recursive: true, force: true });
}

test('memory storage clones input/output and clears only its own state', async () => {
  const initial = session();
  const store = new MemorySessionStore(initial);
  initial.account!.accessToken = 'changed';
  const loaded = await store.load();
  assert.notEqual(loaded?.account?.accessToken, 'changed');
  loaded!.otherAccounts.length = 0;
  assert.equal((await store.load())?.otherAccounts.length, 1);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test('native storage keeps every account separate and avoids rewriting unchanged credentials', async () => {
  const backend = new Backend();
  const lockDirectory = await directory();
  try {
    const store = new NativeSessionStore({
      service: `test-${randomUUID()}`,
      backend,
      lockDirectory,
    });
    assert.equal(await store.load(), undefined);
    await store.save(session());
    assert.deepEqual(await store.load(), session());
    assert.equal(backend.values.size, 3);
    assert.ok(backend.values.get('session')!.length < 300);
    assert.equal(backend.values.get('session')!.includes('accessToken'), false);
    assert.deepEqual(backend.writes, ['account-9812345678', 'account-9823456789', 'session']);
    await store.save(session());
    assert.equal(backend.writes.length, 3);
    backend.values.delete('account-9823456789');
    await store.save(session());
    assert.equal(backend.writes.length, 4);
    assert.deepEqual(await store.load(), session());
    const next = session();
    next.otherAccounts = [];
    await store.save(next);
    assert.equal(backend.values.has('account-9823456789'), false);
    assert.deepEqual(backend.deletions, ['account-9823456789']);
    await store.clear();
    assert.equal(await store.load(), undefined);
    assert.equal(backend.values.size, 0);
    await store.clear();
  } finally {
    await cleanup(lockDirectory);
  }
});

test('native storage readback failure rejects rather than pretending a token rotation was saved', async () => {
  const backend: CredentialBackend = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
  const lockDirectory = await directory();
  try {
    const store = new NativeSessionStore({ backend, lockDirectory });
    await assert.rejects(
      store.save(session()),
      (error) => error instanceof NcellError && error.code === 'STORAGE',
    );
  } finally {
    await cleanup(lockDirectory);
  }
});

test('native storage validates all account records before writing any credential', async () => {
  const backend = new Backend();
  const lockDirectory = await directory();
  try {
    const store = new NativeSessionStore({ backend, lockDirectory });
    const invalid = session();
    invalid.otherAccounts[0]!.account.msisdn = 'invalid';
    await assert.rejects(store.save(invalid), /invalid/);
    assert.deepEqual(backend.writes, []);
    assert.equal(backend.values.size, 0);
  } finally {
    await cleanup(lockDirectory);
  }
});

test('native storage fails visibly for corrupt index, missing account and mismatched device', async () => {
  const backend = new Backend();
  const lockDirectory = await directory();
  const store = new NativeSessionStore({ backend, lockDirectory });
  try {
    backend.values.set('session', 'not json');
    await assert.rejects(
      store.load(),
      (error) => error instanceof NcellError && error.code === 'INVALID_SESSION',
    );
    backend.values.clear();
    await store.save(session());
    const original = backend.values.get('account-9812345678')!;
    backend.values.delete('account-9812345678');
    await assert.rejects(store.load(), /invalid/);
    const account = JSON.parse(original) as { deviceId: string };
    account.deviceId = 'wrong-device';
    backend.values.set('account-9812345678', JSON.stringify(account));
    await assert.rejects(store.load(), /invalid/);
    backend.values.set('account-9812345678', original);
    assert.deepEqual(await store.load(), session());
  } finally {
    await cleanup(lockDirectory);
  }
});

test('native store locking covers nested read-write transactions and rejects another instance', async () => {
  const backend = new Backend();
  const lockDirectory = await directory();
  try {
    const first = new NativeSessionStore({ service: 'same-service', backend, lockDirectory });
    const second = new NativeSessionStore({ service: 'same-service', backend, lockDirectory });
    await first.withLock(async () => {
      await first.save(session());
      assert.deepEqual(await first.load(), session());
      await assert.rejects(
        second.load(),
        (error) => error instanceof NcellError && error.code === 'SESSION_BUSY',
      );
    });
    assert.deepEqual(await second.load(), session());
  } finally {
    await cleanup(lockDirectory);
  }
});

test('native store backend errors do not expose credential contents and lock is released', async () => {
  let unavailable = true;
  const backend: CredentialBackend = {
    get: async () => {
      if (unavailable) throw new Error('sensitive-secret');
      return null;
    },
    set: async () => {},
    delete: async () => {},
  };
  const lockDirectory = await directory();
  try {
    const store = new NativeSessionStore({ backend, lockDirectory });
    await assert.rejects(
      store.load(),
      (error) =>
        error instanceof NcellError &&
        error.code === 'STORAGE' &&
        !error.message.includes('sensitive-secret'),
    );
    unavailable = false;
    assert.equal(await store.load(), undefined);
  } finally {
    await cleanup(lockDirectory);
  }
});

test('native constructor rejects invalid service names without loading native credentials', () => {
  assert.throws(() => new NativeSessionStore('../bad'), /Invalid credential service/);
  assert.equal(new NativeSessionStore().service, 'ncell-app');
});
