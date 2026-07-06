# wt-cli

Installable `wt` command for Git worktrees.

## Why this exists

`wt` keeps the old shell helper behavior in a team-installable CLI:

- create a Git worktree from a safe base ref
- copy local untracked `.env` files into the new worktree
- run the repo setup command
- list, switch, prune, and delete worktrees

## Requirements

- Node.js 18 or newer
- Git
- SSH access to `git@github.com:gitsoufiane/wt.git`
- `fzf` only for `wt -s`

## Install

Install from GitHub:

```sh
npm install -g git+ssh://git@github.com/gitsoufiane/wt.git
```

Update by reinstalling:

```sh
npm install -g git+ssh://git@github.com/gitsoufiane/wt.git
```

Uninstall:

```sh
npm uninstall -g wt-cli
```

During local development in this repo:

```sh
npm link
```

## Commands

| Command             | Does                                      |
| ------------------- | ----------------------------------------- |
| `wt <name>`         | Create a worktree and print its path      |
| `wt --shell <name>` | Create and open a subshell inside it      |
| `wt -s`             | Pick a worktree with `fzf` and print path |
| `wt --shell -s`     | Pick a worktree and open a subshell       |
| `wt -l`             | List worktrees                            |
| `wt -p`             | Prune stale worktree metadata             |
| `wt -d`             | Delete current worktree, keep branch      |
| `wt -D`             | Delete current worktree and branch        |
| `wt sync-env`       | Copy untracked `.env` files               |
| `wt -v`             | Print version                             |

Extra flags, useful for scripts and agents:

| Flag           | Does                                        |
| -------------- | ------------------------------------------- |
| `--json`       | Print JSON instead of text on create/delete |
| `--cwd <dir>`  | Run as if started in `<dir>`                |
| `--no-install` | Skip the setup hook / package install       |
| `--no-env`     | Skip copying `.env` files                   |

Status messages (`wt: ...`) go to stderr. stdout carries only the result:
the path and `cd` line, or the JSON object with `--json`.

## Daily use

Create a worktree:

```sh
wt feature-a
```

The command prints the new path and a `cd ...` command:

```txt
wt: created /Users/me/.worktrees/my-repo/feature-a
/Users/me/.worktrees/my-repo/feature-a
cd '/Users/me/.worktrees/my-repo/feature-a'
```

A binary cannot change the directory of the parent shell. Use `--shell` if you
want `wt` to open a shell inside the new worktree:

```sh
wt --shell feature-a
```

If you prefer a shell helper, add this to your shell profile:

```sh
wtc() {
  local output target
  output="$(wt "$@")" || { printf '%s\n' "$output"; return 1; }
  printf '%s\n' "$output"
  target="$(printf '%s\n' "$output" \
    | awk '/^cd / { sub(/^cd /, ""); line=$0 } END { print line }')"
  [ -n "$target" ] && eval "cd $target"
}
```

Then run:

```sh
wtc feature-a
```

## Defaults

- Worktrees go in `~/.worktrees/<repo-name>/<branch>`.
- Base ref order:
  1. `wt.base`
  2. `WT_BASE`
  3. remote default branch
  4. `origin/this`
  5. `origin/main`
  6. `origin/master`
  7. `HEAD`
- Remote is `wt.remote`, default `origin`.
- Setup runs `wt.hook` if set.
- Without `wt.hook`, setup runs the detected lockfile package manager.
- Untracked `.env` and `.env.*` files are copied into new worktrees.

## Config

Set defaults per repo:

```sh
git config wt.root ~/Desktop/worktree/my-repo
git config wt.base origin/this
git config wt.remote origin
git config wt.hook 'yarn install'
git config wt.copyEnv false
```

Use one-off environment overrides:

```sh
WT_ROOT=~/Desktop/worktree/my-repo WT_BASE=origin/this wt feature-a
WT_SKIP_HOOK=1 wt feature-a
WT_COPY_ENV=false wt feature-a
```

## How it is packaged

npm exposes the terminal command through the `package.json` `bin` field.
The executable starts with `#!/usr/bin/env node`, as npm expects.

Docs:

- npm `bin` field:
  <https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin>
- npm Git install syntax:
  <https://docs.npmjs.com/cli/v11/commands/npm-install>
- Git worktree behavior:
  <https://git-scm.com/docs/git-worktree>

## Agent and AI use

Agents should prefer deterministic commands. Avoid `--shell`; use the printed
path instead.

Good agent defaults:

```sh
wt --json --no-install feature-a
wt --json --no-install --no-env --cwd /path/to/repo feature-a
```

`--json` prints one object on stdout, for example
`{ "path": "...", "branch": "feature-a", "envCopied": 3 }`.

## Suggested improvements

These are not needed for the first team install.

1. Add release tags, then install with
   `npm install -g git+ssh://git@github.com/gitsoufiane/wt.git#v0.1.0`.
   This gives the team a stable version instead of the latest `main` commit.
2. Add `--base` and `--root` flags. Today these exist as Git config or
   environment values only.
3. Add `wt repair` for moved worktrees. Git has `git worktree repair` for this.
4. Publish to a private npm registry if you want normal semantic versions and
   easier updates than Git URL installs.

## Development

Install dev tools:

```sh
npm install
```

Run checks:

```sh
npm run format:check
npm run lint
npm test
```

Format files:

```sh
npm run format
```

Preview the install package:

```sh
npm pack --dry-run
```
