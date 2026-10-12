import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { CommanderError } from 'commander';
import { parseCommand } from '../src/cli/parse.js';
import { tokenize } from '../src/scripts.js';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('docs/index.html', root), 'utf8');
const { document } = parseHTML(html);
const { document: codes } = parseHTML(
  await readFile(new URL('docs/response-codes-content.html', root), 'utf8'),
);

test('documentation links and icons have existing destinations', () => {
  const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const link of document.querySelectorAll('a[href^="#"], use[href^="#"]')) {
    const id = link.getAttribute('href')!.slice(1);
    assert.ok(document.getElementById(id) || codes.getElementById(id), `Missing #${id}`);
  }
});

test('documented CLI examples use supported syntax', () => {
  let examples = 0;
  for (const code of document.querySelectorAll('pre[data-lang="Shell"] code')) {
    for (const line of code.textContent!.split('\n')) {
      if (!line.startsWith('ncell ')) continue;
      assert.doesNotThrow(() => {
        try {
          parseCommand(tokenize(line.replaceAll('98XXXXXXXX', '9800000000')).slice(1), {
            out: () => {},
            err: () => {},
          });
        } catch (error) {
          if (!(error instanceof CommanderError && error.exitCode === 0)) throw error;
        }
      }, line);
      examples++;
    }
  }
  assert.ok(examples > 25);
});

test('public package examples use ncell and keep credential compatibility documented', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, 'ncell');
  assert.equal(pkg.homepage, 'https://rohityadav-sas.github.io/ncell-app/');
  assert.equal(document.querySelector('.version')!.textContent, `v${pkg.version}`);
  for (const code of document.querySelectorAll('pre[data-lang="TypeScript"] code')) {
    assert.doesNotMatch(code.textContent!, /from ['"]ncell-app/);
  }
  assert.match(document.getElementById('sessions')!.nextElementSibling!.textContent!, /separate/);
});
