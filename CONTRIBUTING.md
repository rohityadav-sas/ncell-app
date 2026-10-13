# Development

## Sources of truth

- `package.json` owns the npm package version. The CLI reads it at runtime. `npm version` updates the generated lockfile version.
- Build and version hooks refresh website labels and ignored `docs/version.json` from the package manifest.
- `docs-source/index.html` owns TypeScript-specific documentation. `npm run docs:sync` imports shared CLI content, navigation, theme and the response-code reference from the Rust repository. For local edits, use `npm run docs:sync -- --source ../ncell-cli`.
- `src/core/catalog.ts` owns the default plan category. The CLI parser and account API reuse it.
- `src/core/endpoints.ts` owns the game-service base URL for identity links and game requests.
- The README npm badge reads the published registry version. Historical verification notes describe the release they tested.

## Version updates

```sh
npm version patch --no-git-tag-version
npm run check
npm run format:check
```

Commit the manifest, generated lockfile and refreshed documentation together. Publish after checks pass. A normal build refreshes version labels without fetching shared documentation or using account credentials.
