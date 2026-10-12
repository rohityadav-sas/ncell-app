# Verification

Verified on October 13, 2026.

## Automated checks

| Environment                         | Result                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Windows, Node.js 24.21.0            | All 138 tests passed, including native credential tests.                    |
| Windows, Node.js 22.12.0            | All 138 tests passed, including native credential tests.                    |
| Ubuntu through WSL, Node.js 24.21.0 | All 133 regular tests passed, followed by both native Secret Service tests. |
| TypeScript and build                | Strict checking and declaration generation passed.                          |
| Formatting                          | Prettier checks passed.                                                     |
| Production dependencies             | npm audit reported zero known vulnerabilities.                              |

Tests cover every command family through the CLI and shared SDK. They include OTP and refresh flows, account selection and removal, storage failures, catalog sorting, mocked SMS and purchases, game rewards, complete math games, manual answers, cancellation and response-stream failures.

Script checks cover quoted arguments, comments, UTF-8, full-file validation before requests, failure stopping, account changes, saved/current-directory resolution, overwrite protection, editor hooks, deletion, progress, spacing and structured JSON.

Native storage tests use disposable credential services. They verify persistence across separate processes, multi-account bindings, locking, legacy password compatibility and Windows credential-size failure handling. They do not delete real account credentials.

The packed npm archive was installed in a separate consumer project. Default and named ESM imports, CommonJS imports, exported TypeScript types, the CLI subpath, command help and version all passed on Node.js 22.12.0. That Node release prints its own experimental warning for CommonJS loading of ESM; the import succeeds.

macOS was not tested, as requested.

## Live server checks

Using the authorized account, OTP login, refresh, saved-session metadata, balance, profile, catalog categories, plan search, game status and rankings succeeded.

Check-in and individual task claims returned normal already-completed results. Claiming all tasks succeeded when no rewards were available. Spin and math returned the expected insufficient-token responses. All-token play stopped without spending the remaining 15 tokens.

Successful gameplay was tested with mocks, including complete twenty-question math games. It could not be tested live because the account had fewer than the required 25 tokens. No live SMS messages or plan purchases were made.

## Repeat the checks

```sh
npm ci
npm run check
npm run format:check
```

Native tests are optional because they require an unlocked OS credential store. Enable them with `NCELL_NATIVE_TEST=1` in your shell before running `npm test`. On Linux, use an unlocked Secret Service keyring and a working D-Bus session.

These checks describe the tested implementation and observed server responses. They cannot guarantee future behavior if Ncell changes its API.
