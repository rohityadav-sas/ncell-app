# Command reference

After building, run `node dist/cli/main.js` instead of `ncell` if the command is not linked.

Commands and subcommands use words. Required targets, such as an account number or script name, are positional arguments. Optional settings use `--long-options`. Use `-h` or `--help` for help and `-V` or `--version` for the version.

## Global options

| Option            | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--json`          | Print indented structured output. Works before or after a command. |
| `-h`, `--help`    | Show help for the selected command.                                |
| `-V`, `--version` | Show the package version.                                          |

Set `NO_COLOR=1` to disable terminal colors. Normal dates use Nepal time and a 12-hour clock.

## Interactive mode

Run `ncell` to open the live dropdown prompt. Type commands without the `ncell` prefix. Ctrl+Space requests suggestions, Up/Down selects a match, and Tab or Enter accepts it. Enter on a completed command executes it. Esc closes only the dropdown; argument hints remain. Ctrl+A selects the line, Ctrl+Backspace deletes the previous word, and Ctrl+C or `exit` closes the prompt. `clear` empties the screen and shows the banner again.

Categories are loaded from the active account. Script filenames come from the script library and current directory. Commands run normally, including account changes, SMS, subscriptions and games. An interactive terminal is required; use one-shot CLI commands for redirected input and automation.

## Documentation

| Command      | Behavior                                                |
| ------------ | ------------------------------------------------------- |
| `ncell docs` | Open the packaged documentation in the default browser. |

## Accounts

| Command                                 | Arguments and behavior                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ncell login <number> [--verify]`       | Request an OTP, prompt for it, save the account and make it active. `--verify` resumes a pending OTP. |
| `ncell account add <number> [--verify]` | Request and verify an OTP, then save the account without switching.                                   |
| `ncell account list`                    | List saved accounts and mark the active one.                                                          |
| `ncell account switch <number>`         | Make a saved account active.                                                                          |
| `ncell account remove <number>`         | Remove that account locally. Another saved account becomes active if necessary.                       |
| `ncell status`                          | Show saved account and token timestamps. Does not verify server acceptance.                           |
| `ncell logout`                          | Remove the active account locally and select another saved account if available.                      |
| `ncell refresh`                         | Rotate tokens and save the result.                                                                    |

Use a 10-digit Nepal mobile number or prefix it with `+977`. OTP input remains visible. Credentials use the native OS store under `ncell-app`, separate from the Rust CLI's credentials.

## Balance and profile

| Command         | Behavior                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------ |
| `ncell balance` | Show account balance, recharge, expiry and pack details. Hide empty zero-valued summaries. |
| `ncell profile` | Show subscriber details. Use `--json` for the API body.                                    |

## Plans

| Command                        | Arguments and options                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `ncell plans`                  | `[--category <id>] [--sort <fields>]`                                                                     |
| `ncell plans categories`       | List available catalog categories.                                                                        |
| `ncell plans search <keyword>` | `[--category <id>] [--sort <fields>]`                                                                     |
| `ncell plans subscribe <id>`   | `[--category <id>] [--yes] [--dry-run]`; buying asks for confirmation, so scripts and pipes need `--yes`. |

The default category is `66`. The default sort is ascending price. Sort fields are `price` and `validity`; append `:asc` or `:desc` and separate multiple fields with commas:

```sh
ncell plans search data --category 66 --sort price,validity:desc
```

Put plan options after the selected subcommand, as in the example.

## SMS

| Command                               | Behavior                                       |
| ------------------------------------- | ---------------------------------------------- |
| `ncell sms send-free <number> <text>` | Send a free SMS. Quote text containing spaces. |

```sh
ncell sms send-free 98XXXXXXXX "Hello from Ncell"
```

## Games

| Command                          | Arguments and options                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `ncell game check-in`            | Claim the daily reward. Already checked-in results succeed.                             |
| `ncell game status`              | Show tasks, progress, tokens, XP, reset period and claim state.                         |
| `ncell game claim-task <ids...>` | Use comma-separated IDs, space-separated IDs or `all`. Already claimed results succeed. |
| `ncell game ranks`               | Show your performance, weekly prizes and the leaderboard.                               |
| `ncell game spin`                | `[--count <number\|all>] [--delay <duration>]`                                          |
| `ncell game scratch`             | `[--count <number\|all>] [--delay <duration>]`                                          |
| `ncell game math`                | `[--count <number\|all>] [--delay <duration>]`                                          |

```sh
ncell game claim-task 1,2,3
ncell game claim-task 1 2 3
ncell game claim-task all
ncell game spin --count 5 --delay 1.5s
ncell game scratch --count all --delay 2m
```

`claim-task all` fetches task status and claims completed, unclaimed tasks in response order. An empty claim list succeeds. Each claim result appears immediately.

The default count is `1` and default delay is `0`. Bare delay numbers are seconds. Supported suffixes are `s`, `m` and `h`, with decimals such as `1.5s` or `1.5h`. Waiting occurs between games and shows a countdown in the terminal.

Each supported game currently costs 25 game tokens. `--count all` spends the available balance while it can pay that fee. Progress totals adapt to returned balances. Insufficient tokens end an all-token run successfully; numeric counts fail if a requested game cannot be played. There is no `--max-games` option.

Math solves supported questions automatically and prompts for unsupported ones. A lost game stops the run. Math's `bg_reward` is not a token refund and appears only in JSON. Spin and scratch use returned token balances; math deducts its entry fee.

Repeated commands reuse game cookies and CSRF within the same app instance. Reward requests are not automatically retried.

## Scripts

| Command                            | Behavior                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `ncell script create <name.ncell>` | Save the example in the script library and open the default text editor. Refuse overwrites. |
| `ncell script edit <name.ncell>`   | Open a saved library script in the text editor.                                             |
| `ncell script list`                | List `.ncell` files saved in the script library.                                            |
| `ncell script run <file>`          | Resolve a saved name first, then the current directory; file paths are also accepted.       |
| `ncell script delete <name.ncell>` | Delete a saved library script.                                                              |

The library uses the same `ncell-cli/scripts` application-data location as the Rust CLI. Credentials are stored separately.

Scripts are UTF-8 text with one command per line. The `ncell` prefix is optional. Blank lines and lines starting with `#` are ignored. Quote arguments containing spaces. Shell syntax and nested script commands are rejected.

```text
# Rewards
ncell game check-in
ncell game claim-task all

# Final checks
game status
game ranks
```

The entire file is validated before requests begin. Commands then run in order. Account changes affect later commands. Normal output shows a colored `Step X of Y · command` heading, a blank line, and the command's output.

Any command failure stops later steps and returns a nonzero exit code. Errors identify both the executed step and the physical source line:

```text
Step 3 of 14 (line 6): Not enough points (HTTP 200)
```

## JSON output

```sh
ncell balance --json
ncell game spin --count 3 --json
ncell script run daily.ncell --json
```

Single responses are indented JSON. Commands with multiple results emit separate JSON objects as they finish. Read them as a JSON stream rather than expecting one combined array. JSON output has no colors or decorative headings.

Script results have `event`, `step`, `total`, `line`, `command` and `result` fields. JSON scripts emit a final completion event. Repeated games include progress and answer events. Errors are structured and preserve the server response when available.

Account/session output exposes metadata rather than saved tokens. Status timestamps describe local credentials; they do not prove the server accepts those credentials.
