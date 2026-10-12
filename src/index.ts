import { NcellApp } from './app.js';
export { NcellApp, createNcellApp, parseCount, parseDelay } from './app.js';
export type {
  NcellOptions,
  PlayOptions,
  PlayResult,
  GameEvent,
  GameKind,
  GameCount,
} from './app.js';
export * from './core/index.js';
export { sortPlans, parseSort } from './plans.js';
export type { PlanOptions } from './plans.js';
export { ScriptLibrary, SCRIPT_TEMPLATE, parseScript, executeScript, tokenize } from './scripts.js';
const ncell = new NcellApp();
export default ncell;
