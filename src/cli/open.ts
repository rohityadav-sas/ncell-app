import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NcellError } from '../core/index.js';

/** Packaged documentation page; resolvable both installed and from a checkout. */
export function docsFile(): string {
  return fileURLToPath(new URL('../../docs/index.html', import.meta.url));
}

export async function openDocs(
  opener: (target: string) => Promise<void> = openBrowser,
): Promise<string> {
  const file = docsFile();
  try {
    await access(file);
  } catch {
    throw new NcellError('Documentation is not included with this installation');
  }
  await opener(pathToFileURL(file).href);
  return file;
}

/** Open a URL in the default browser without waiting for it to close. */
export function openBrowser(target: string): Promise<void> {
  const [command, args] =
    process.platform === 'win32'
      ? (['rundll32.exe', ['url.dll,FileProtocolHandler', target]] as const)
      : process.platform === 'darwin'
        ? (['open', [target]] as const)
        : (['xdg-open', [target]] as const);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.unref();
    resolve();
  });
}
