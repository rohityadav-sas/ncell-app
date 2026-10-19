import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { NcellError } from '../core/index.js';

const { homepage } = createRequire(import.meta.url)('../../package.json') as {
  homepage?: unknown;
};

export async function openDocs(
  opener: (target: string) => Promise<void> = openBrowser,
): Promise<string> {
  if (typeof homepage !== 'string' || homepage.trim() === '') {
    throw new NcellError('Set homepage in package.json to the online documentation URL');
  }
  try {
    await opener(homepage);
  } catch (cause) {
    throw new NcellError(`Could not open a browser. Documentation: ${homepage}`, { cause });
  }
  return homepage;
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
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
