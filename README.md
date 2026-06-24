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

| Command | What it does |
| --- | --- |
| `wt <name>` | Create a worktree and print its path |
| `wt --shell <name>` | Create a worktree and open a subshell inside it |
| `wt -s` | Pick an existing worktree with `fzf` and print its path |
| `wt --shell -s` | Pick an existing worktree and open a subshell inside it |
| `wt -l` | List worktrees |
| `wt -p` | Prune stale worktree metadata |
| `wt -d` | Delete the current worktree and keep its branch |
| `wt -D` | Delete the current worktree and delete its branch |
| `wt sync-env` | Copy untracked `.env` files from the main repo |

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
WT_SKIP_HOOK=1 wt feature-a
WT_ROOT=/tmp/worktrees/my-repo WT_SKIP_HOOK=1 wt feature-a
```

Suggested agent-focused improvements:

1. Add `--json` for machine-readable output, for example
   `{ "path": "...", "branch": "...", "envCopied": 3 }`.
2. Add `--cwd <repo>` so agents can run `wt` from any directory.
3. Add `--no-install` as a flag version of `WT_SKIP_HOOK=1`.
4. Add `--no-env` for clean test worktrees. Default should still copy `.env`.

## Suggested improvements

These are not needed for the first team install.

1. Add release tags, then install with
   `npm install -g git+ssh://git@github.com/gitsoufiane/wt.git#v0.1.0`.
   This gives the team a stable version instead of the latest `main` commit.
2. Add `--base`, `--root`, and `--no-install` flags. Today these exist as
   Git config or environment values only.
3. Parse `git worktree list --porcelain -z`. Git documents `-z` as safer for
   unusual paths.
4. Add `wt repair` for moved worktrees. Git has `git worktree repair` for this.
5. Publish to a private npm registry if you want normal semantic versions and
   easier updates than Git URL installs.

## Development

Run tests:

```sh
npm test
```

Preview the install package:

```sh
npm pack --dry-run
```
