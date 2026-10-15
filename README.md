<p align="center">
  <img src="https://raw.githubusercontent.com/gitsoufiane/wt/main/assets/icon.svg" alt="wt icon" width="112" height="112">
</p>

<h1 align="center">wt</h1>

<p align="center">
  Git worktrees in one command: create, switch, and clean up,<br>
  with your <code>.env</code> files and dependencies ready.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gitsoufiane/wt"><img alt="npm" src="https://img.shields.io/npm/v/@gitsoufiane/wt?color=f97316"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-22c55e"></a>
  <img alt="Node 18+" src="https://img.shields.io/badge/node-%3E%3D18-38bdf8">
</p>

```sh
npm install -g @gitsoufiane/wt
wt feature-a        # new worktree at ~/.worktrees/<repo>/feature-a
```

## Why wt

Plain Git needs several steps for each new worktree:

```sh
git fetch origin
git worktree add -b feature-a ../feature-a origin/main
cp .env ../feature-a/ && cd ../feature-a && npm install
```

`wt feature-a` does all of that:

- **Safe base.** Fetches the remote, then branches from the remote default
  branch. If `origin/feature-a` exists, it checks it out and tracks it.
- **Ready to run.** Copies untracked `.env` and `.env.*` files and runs the
  install for your lockfile (`npm`, `pnpm`, `yarn`, or `bun`), or your own hook.
- **Easy cleanup.** `wt -D feature-a` removes the worktree and the branch.
- **Script and agent friendly.** `--json` prints one JSON object on stdout.

## Install

Requirements: Node.js 18+, Git, and `fzf` only for `wt -s`.

| Task      | Command                                 |
| --------- | --------------------------------------- |
| Install   | `npm install -g @gitsoufiane/wt`        |
| Update    | `npm install -g @gitsoufiane/wt@latest` |
| Uninstall | `npm uninstall -g @gitsoufiane/wt`      |

> [!WARNING]
> The npm name `wt-cli` belongs to a different package. If you installed an
> older version of this tool as `wt-cli`, run `npm uninstall -g wt-cli` first,
> and never install `wt-cli` from the registry.

## Commands

| Command             | Does                                       |
| ------------------- | ------------------------------------------ |
| `wt <name>`         | Create a worktree and print its path       |
| `wt --shell <name>` | Create and open a subshell inside it       |
| `wt -s`             | Pick a worktree with `fzf` and print path  |
| `wt --shell -s`     | Pick a worktree and open a subshell        |
| `wt -l`             | List worktrees                             |
| `wt -p`             | Prune stale worktree metadata              |
| `wt -d [<name>]`    | Delete current/named worktree, keep branch |
| `wt -D [<name>]`    | Delete current/named worktree and branch   |
| `wt <name> -D`      | Delete named worktree (if any) and branch  |
| `wt sync-env`       | Copy untracked `.env` files                |
| `wt -v`             | Print version                              |

Flags:

| Flag           | Does                                        |
| -------------- | ------------------------------------------- |
| `--json`       | Print JSON instead of text on create/delete |
| `--cwd <dir>`  | Run as if started in `<dir>`                |
| `--no-install` | Skip the setup hook / package install       |
| `--no-env`     | Skip copying `.env` files                   |
| `--force`      | Discard uncommitted changes when deleting   |

Status messages (`wt: ...`) go to stderr. stdout carries only the result:
the path and `cd` line, or the JSON object with `--json`.

## Daily use

```console
$ wt feature-a
wt: created /Users/me/.worktrees/my-repo/feature-a
/Users/me/.worktrees/my-repo/feature-a
cd '/Users/me/.worktrees/my-repo/feature-a'
```

A program cannot change the directory of the shell that started it. Pick one:

- `wt --shell feature-a` opens a new shell inside the worktree.
- Add this helper to your shell profile, then run `wtc feature-a`:

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

## Defaults

- Worktrees go in `~/.worktrees/<repo-name>/<branch>`, also when you run `wt`
  from a linked worktree.
- If `<remote>/<name>` exists, `wt <name>` checks it out and tracks it, so you
  can open a teammate's branch. Otherwise the new branch has no upstream.
- If the fetch fails (for example, offline), `wt` warns and uses local refs.
- Base ref order for new branches: `wt.base`, `WT_BASE`, the remote default
  branch, `origin/this`, `origin/main`, `origin/master`, then `HEAD`.
- The remote is `wt.remote`, default `origin`.
- Setup runs `wt.hook` if set. Otherwise it runs the install for the detected
  lockfile.

## Config

Set defaults per repo:

```sh
git config wt.root ~/Desktop/worktree/my-repo
git config wt.base origin/this
git config wt.remote origin
git config wt.hook 'yarn install'
git config wt.copyEnv false
```

One-off environment overrides:

```sh
WT_ROOT=~/Desktop/worktree/my-repo WT_BASE=origin/this wt feature-a
WT_SKIP_HOOK=1 wt feature-a
WT_COPY_ENV=false wt feature-a
```

## Use with AI agents

Agents should use deterministic commands. Avoid `--shell`; use the printed
path instead.

```sh
wt --json --no-install feature-a
wt --json --no-install --no-env --cwd /path/to/repo feature-a
```

`--json` prints one object on stdout, for example
`{ "path": "...", "branch": "feature-a", "base": "origin/main", "envCopied": 3 }`.

### Agent skill

[`skills/wt/SKILL.md`](skills/wt/SKILL.md) teaches coding agents these rules.
It follows the [Agent Skills specification](https://agentskills.io/specification).
The skill only gives instructions, so install the `wt` command too.

| Agent                              | Install the skill                             |
| ---------------------------------- | --------------------------------------------- |
| Claude Code, Codex, Cursor, others | `npx skills add gitsoufiane/wt --skill wt -g` |
| Pi                                 | `pi install npm:@gitsoufiane/wt`              |

The first command uses the [skills CLI](https://github.com/vercel-labs/skills).
The second installs this repo as a [Pi package](https://pi.dev/packages).

## Roadmap

1. Add `--base` and `--root` flags. Today these exist as Git config or
   environment values only.
2. Add `wt repair` for moved worktrees. Git has `git worktree repair` for this.
3. Remove locked worktrees. `git worktree remove` needs `--force` twice for
   them, and `wt --force` passes it once.

## Development

```sh
npm install          # dev tools
npm link             # use this checkout as the global wt
npm run format:check
npm run lint
npm test
npm pack --dry-run   # preview the published files
```

## Release

`.github/workflows/publish.yml` publishes to npm when you push a `v*` tag. It
uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/), so no
npm token is stored in GitHub, and npm adds provenance for this public repo.

One-time setup:

1. Publish the first version by hand. The trusted publisher is set on the
   package settings page, so the package must exist: `npm login`, then
   `npm publish`. `publishConfig.access` makes the scoped package public.
2. On npmjs.com, open the package, then **Settings** -> **Trusted Publisher**.
   Pick GitHub Actions, user `gitsoufiane`, repo `wt`, workflow `publish.yml`.
3. Push the next tag within 2 days. npm expires a trusted publisher that has
   not published within 2 days of its creation.

Each release:

```sh
npm version patch   # or minor / major; commits and tags vX.Y.Z
git push --follow-tags
```

## License

[MIT](LICENSE)
