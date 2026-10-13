import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHtml } from '../scripts/sync-docs.mjs';

const template = `<html><!-- shared-sidebar --><template id="package-navigation"><a href="#sdk">Package</a></template><article><!-- shared-section:scripts --><h2 id="sdk">SDK</h2><p>Keep my edits.</p></article><footer>v{{version}}</footer></html>`;
const source = `<nav aria-label="Documentation"><a href="#scripts">Scripts</a><p class="nav-title">Reference</p></nav><article><h2 id="scripts">Scripts</h2><p>Shared edits.</p><h2 id="commands">Commands</h2></article>`;

test('shared docs updates retain package sections, navigation and version', () => {
  const result = renderHtml(template, source, '9.8.7');
  assert.match(result, /Shared edits/);
  assert.match(result, /Keep my edits/);
  assert.match(result, /v9\.8\.7/);
  assert.equal((result.match(/href="#sdk"/g) || []).length, 1);
  assert.doesNotMatch(result, /shared-section|shared-sidebar|<template/);
  assert.ok(result.indexOf('href="#sdk"') < result.indexOf('nav-title'));
  assert.equal(renderHtml(template, source, '9.8.7'), result);
});

test('missing shared headings fail instead of silently dropping content', () => {
  assert.throws(
    () => renderHtml(template, source.replace('id="scripts"', 'id="removed"'), '1'),
    /Missing shared section/,
  );
  assert.throws(() => renderHtml(template, '', '1'), /Missing documentation navigation/);
});

test('Rust-only repeated sorting example is excluded from TypeScript docs', () => {
  const sortTemplate = template.replace('shared-section:scripts', 'shared-section:searching');
  const sortSource = source.replace(
    '<h2 id="scripts">Scripts</h2><p>Shared edits.</p>',
    '<h2 id="searching">Sorting</h2><h4>Repeat the sort option</h4><p>Rust only</p><pre>repeated options</pre><h4>Use the default direction</h4><pre>--sort price,validity</pre>',
  );
  const result = renderHtml(sortTemplate, sortSource, '1');
  assert.doesNotMatch(result, /Rust only|repeated options/);
  assert.match(result, /--sort price,validity/);
});
