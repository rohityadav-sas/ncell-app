import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { NativeSessionStore } from '../src/core/index.js';

const execute = promisify(execFile);

test(
  'native OS credentials persist across processes and retain account bindings through every local flow',
  {
    skip:
      process.env.NCELL_NATIVE_TEST !== '1'
        ? 'Set NCELL_NATIVE_TEST=1 to exercise your OS credential store using a disposable service'
        : false,
    timeout: 60_000,
  },
  async () => {
    const service = `ncell-app-test-${randomUUID()}`;
    const module = pathToFileURL(resolve('src/core/index.ts')).href;
    const store = new NativeSessionStore(service);
    const child = async (operation: string): Promise<Record<string, unknown>> => {
      const code = `
      import { AccountService, NativeSessionStore } from ${JSON.stringify(module)};
      const store = new NativeSessionStore(${JSON.stringify(service)});
      const client = new AccountService({ store });
      const operation = ${JSON.stringify(operation)};
      const makeAccount = (msisdn, token) => ({ msisdn, accessToken: token.repeat(1200), refreshToken: 'r'.repeat(800), authenticatedAt: '2026-10-13T00:00:00.000Z' });
      if (operation === 'save') await store.save({ deviceId: 'first-device', account: makeAccount('9812345678','a'), otherAccounts: [{ deviceId: 'second-device', account: makeAccount('9823456789','b') }] });
      if (operation === 'switch') await client.switchAccount('9823456789');
      if (operation === 'remove-inactive') await client.removeAccount('9812345678');
      if (operation === 'remove-last') await client.removeAccount('9823456789');
      if (operation === 'logout') await client.logout();
      const session = await store.load();
      console.log(JSON.stringify({
        exists: session !== undefined,
        deviceId: session?.deviceId,
        active: session?.account?.msisdn,
        accessLength: session?.account?.accessToken.length,
        accessFirst: session?.account?.accessToken.at(0),
        refreshLength: session?.account?.refreshToken?.length,
        accounts: await client.listAccounts(),
      }));
    `;
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code],
        {
          cwd: resolve('.'),
          timeout: 20_000,
          windowsHide: true,
        },
      );
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    try {
      const initial = await child('save');
      assert.equal(initial.deviceId, 'first-device');
      assert.equal(initial.accessLength, 1200);
      assert.equal(initial.refreshLength, 800);
      assert.deepEqual(await child('read'), initial);
      await store.withLock(async () => {
        await assert.rejects(child('read'), /Another command is using the saved accounts/);
      });
      const second = await child('switch');
      assert.equal(second.deviceId, 'second-device');
      assert.equal(second.active, '9823456789');
      assert.equal(second.accessFirst, 'b');
      assert.deepEqual(await child('read'), second);
      const removed = await child('remove-inactive');
      assert.deepEqual(removed.accounts, [{ msisdn: '9823456789', active: true }]);
      assert.equal((await child('remove-last')).exists, false);
      assert.equal((await child('read')).exists, false);
      await child('save');
      const promoted = await child('logout');
      assert.equal(promoted.active, '9823456789');
      assert.equal(promoted.deviceId, 'second-device');
      assert.deepEqual(promoted.accounts, [{ msisdn: '9823456789', active: true }]);
      assert.equal((await child('logout')).exists, false);
    } finally {
      await store.clear();
    }
  },
);

test(
  'native UTF-8 secrets reject unmarked entries and respect platform credential limits',
  {
    skip:
      process.env.NCELL_NATIVE_TEST !== '1'
        ? 'Set NCELL_NATIVE_TEST=1 to test native credential encoding compatibility'
        : false,
    timeout: 20_000,
  },
  async () => {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const service = `ncell-app-test-${randomUUID()}`;
    const index = new AsyncEntry(service, 'session', { linux: { store: 'secret-service' } });
    const accountEntry = new AsyncEntry(service, 'account-9812345678', {
      linux: { store: 'secret-service' },
    });
    const store = new NativeSessionStore(service);
    try {
      const account = {
        msisdn: '9812345678',
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        authenticatedAt: '2026-10-13T00:00:00.000Z',
      };
      await accountEntry.setPassword(JSON.stringify({ deviceId: 'legacy-device', account }));
      await index.setPassword(
        JSON.stringify({
          storageVersion: 1,
          deviceId: 'legacy-device',
          activeMsisdn: '9812345678',
          savedAccounts: ['9812345678'],
        }),
      );
      await assert.rejects(store.load(), /Saved session is invalid/);
      await accountEntry.deleteCredential();
      await index.deleteCredential();
      await store.save({ deviceId: 'legacy-device', otherAccounts: [], account });
      assert.equal((await store.load())?.account?.accessToken, 'legacy-access');
      const session = await store.load();
      assert.ok(session?.account);
      session.account.accessToken = 'x'.repeat(3000);
      if (process.platform === 'win32') {
        await assert.rejects(store.save(session), /Credential storage/);
        assert.equal((await store.load())?.account?.accessToken, 'legacy-access');
      } else {
        await store.save(session);
        assert.equal((await store.load())?.account?.accessToken, session.account.accessToken);
      }
      session.account.accessToken = 'new-access';
      await store.save(session);
      assert.equal(
        (await new NativeSessionStore(service).load())?.account?.accessToken,
        'new-access',
      );
      const secret = await accountEntry.getSecret();
      assert.ok(secret);
      assert.ok(Buffer.from(secret).subarray(0, 12).equals(Buffer.from('ncell-app:1\n')));
    } finally {
      await store.clear();
      await index.deleteCredential();
      await accountEntry.deleteCredential();
    }
  },
);
