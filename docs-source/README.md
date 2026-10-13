# Documentation maintenance

Shared CLI documentation is maintained in `rohityadav-sas/ncell-cli`, under `docs/`.
Edit accounts, plans, SMS, games, scripts, command reference, response codes, styling
and browser behavior there.

Edit `docs-source/index.html` here for npm installation, package examples, credential
storage and TypeScript branding. The template contains placeholders for shared sections
and navigation. Do not edit the generated `docs/index.html`, `docs/app.js`,
`docs/style.css`, `docs/response-codes-content.html` or `docs/third-party-notices.txt`.

Run `npm run docs:sync` to fetch one consistent revision of the shared source.
For local work with both repositories, run:

```sh
npm run docs:sync -- --source ../ncell-cli
```

Commit generated files together with template changes so the npm archive and local
preview include the current documentation. The Pages workflow also generates the site
before deploying. It runs on relevant pushes, manually, and hourly to pick up shared
source changes. Scheduled GitHub Actions may run late; use the manual workflow for an
immediate update. No cross-repository token or extra repository is required.

The generated TypeScript command reference omits Rust's repeated `--sort` example
because the TypeScript parser accepts comma-separated fields instead.
