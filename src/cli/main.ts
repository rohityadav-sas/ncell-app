#!/usr/bin/env node
import { CommanderError } from 'commander';
import { runCli, errorOutput } from './program.js';

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(errorOutput(error, process.argv.includes('--json')));
    process.exitCode = 1;
  }
}
