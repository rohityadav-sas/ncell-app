import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const root = fileURLToPath(new URL('../', import.meta.url));
const sharedFiles = [
  'index.html',
  'app.js',
  'style.css',
  'response-codes-content.html',
  'third-party-notices.txt',
];

export function renderHtml(template, shared, version) {
  const packageNavigation = template.match(
    /<template id="package-navigation"\s*>([\s\S]*?)<\/template>/,
  );
  const sidebar = shared.match(/<nav aria-label="Documentation">[\s\S]*?<\/nav>/)?.[0];
  if (!packageNavigation || !sidebar) throw new Error('Missing documentation navigation');
  let result = template
    .replace(packageNavigation[0], '')
    .replace(
      '<!-- shared-sidebar -->',
      sidebar.replace(
        '<p class="nav-title">Reference</p>',
        packageNavigation[1] + '<p class="nav-title">Reference</p>',
      ),
    );
  result = result.replace(/<!-- shared-section:([\w-]+) -->/g, (_, id) => {
    const start = shared.indexOf(`<h2 id="${id}"`);
    if (start < 0) throw new Error(`Missing shared section: ${id}`);
    let end = shared.indexOf('<h2 ', start + 1);
    if (end < 0) end = shared.indexOf('</article>', start);
    if (end < 0) throw new Error(`Unclosed shared section: ${id}`);
    let section = shared.slice(start, end);
    // Commander accepts comma-separated sort fields, not Rust's repeated option form.
    if (id === 'searching')
      section = section.replace(/\s*<h4>Repeat the sort option<\/h4>[\s\S]*?<\/pre>/, '');
    return section;
  });
  return result.replaceAll('{{version}}', version);
}

export async function syncDocs(sourceDirectory) {
  let readShared;
  if (sourceDirectory) {
    readShared = (name) => readFile(resolve(sourceDirectory, 'docs', name), 'utf8');
  } else {
    // Resolve once so every file comes from the same source revision.
    const response = await fetch(
      'https://api.github.com/repos/rohityadav-sas/ncell-cli/commits/main',
    );
    if (!response.ok)
      throw new Error(`Cannot resolve shared docs revision: HTTP ${response.status}`);
    const { sha } = await response.json();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid shared docs revision');
    readShared = async (name) => {
      const response = await fetch(
        `https://raw.githubusercontent.com/rohityadav-sas/ncell-cli/${sha}/docs/${name}`,
      );
      if (!response.ok) throw new Error(`Cannot fetch ${name}: HTTP ${response.status}`);
      return response.text();
    };
  }
  const files = await Promise.all(sharedFiles.map(readShared));
  const template = await readFile(resolve(root, 'docs-source/index.html'), 'utf8');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  files[0] = renderHtml(template, files[0], pkg.version);
  const options = JSON.parse(await readFile(resolve(root, '.prettierrc.json'), 'utf8'));
  // Parse every generated asset before writing any output.
  const formatted = await Promise.all(
    files.map((text, index) => {
      const name = sharedFiles[index];
      const parser = name.endsWith('.html')
        ? 'html'
        : name.endsWith('.js')
          ? 'babel'
          : name.endsWith('.css')
            ? 'css'
            : null;
      return parser ? format(text, { ...options, parser }) : text;
    }),
  );
  await Promise.all(
    formatted.map((text, index) => writeFile(resolve(root, 'docs', sharedFiles[index]), text)),
  );
  await writeFile(
    resolve(root, 'docs/version.json'),
    JSON.stringify({ version: pkg.version }) + '\n',
  );
  console.log('Synchronized documentation from ncell-cli.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source'))
    throw new Error('Usage: sync-docs.mjs [--source <ncell-cli directory>]');
  await syncDocs(args[1]);
}
