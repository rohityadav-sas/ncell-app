import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const page = new URL('docs/index.html', root);
const html = await readFile(page, 'utf8');
await writeFile(
  page,
  html
    .replace(/(<span class="version">)v[^<]+/g, `$1v${version}`)
    .replace(/(<p>ncell )v[^ ]+/g, `$1v${version}`),
);
await writeFile(new URL('docs/version.json', root), JSON.stringify({ version }) + '\n');
