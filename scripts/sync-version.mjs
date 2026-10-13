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
// Stamp the manifest version into the banner badges so the artwork never
// shows a stale release. SVG cannot fetch version.json at runtime.
const tag = `v${version}`;
for (const asset of ['docs/assets/banner.svg', 'docs/assets/banner-mobile.svg']) {
  const file = new URL(asset, root);
  const svg = await readFile(file, 'utf8');
  const updated = svg.replace(/v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?/g, tag);
  if (updated !== svg) await writeFile(file, updated);
}
