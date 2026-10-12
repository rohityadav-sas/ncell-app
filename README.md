<div align="center">

![ncell](https://raw.githubusercontent.com/rohityadav-sas/ncell-app/main/docs/assets/banner.svg)

<img alt="Written in TypeScript" src="https://img.shields.io/badge/Written_in-TypeScript-702DA0?style=for-the-badge&logo=typescript&logoColor=white">
<img alt="npm version" src="https://img.shields.io/npm/v/ncell?style=for-the-badge&color=702DA0">
<img alt="MIT licensed" src="https://img.shields.io/badge/license-MIT-1F9D55?style=for-the-badge">

**[Read the documentation →](https://rohityadav-sas.github.io/ncell-app/)**

</div>

A TypeScript package and CLI for Ncell accounts. The CLI and package share the same implementation.

## Example

```sh
ncell plans search "SMS" --category 50 --sort price
```

### Output

```text
ID      Plan                             Price    Validity
----------------------------------------------------------
984     1 Day: 100 All Net SMS          Rs. 15       1 DAY
985     7 Day: 300 All Net SMS          Rs. 45       7 DAY
986     28 Day: 300 All Net SMS         Rs. 98      28 DAY
987     28 Day : 850 All Net SMS       Rs. 125      28 DAY
```

## Installation

Requires Node.js 22.12 or newer. Works on Windows, macOS and Linux.

**CLI**

```sh
npm install -g ncell
ncell --help
```

Run without installing globally:

```sh
npx ncell --help
```

**Package**

```sh
npm install ncell
```

```ts
import ncell from 'ncell';

// Uses your saved active account.
console.log(await ncell.balance());
```

Read the [docs](https://rohityadav-sas.github.io/ncell-app/#sdk) for login, methods, events and custom storage.
