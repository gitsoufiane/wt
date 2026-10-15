---
name: wt
description: Create, find, and delete Git worktrees with the wt CLI, including copying .env files and running the package install. Use when the user asks for a new worktree, a separate checkout or branch folder, parallel work on another branch, or cleaning up worktrees, or mentions wt.
compatibility: Requires git, Node.js 18+, and the wt command (npm install -g @gitsoufiane/wt).
---

# wt

`wt` manages Git worktrees. It creates `~/.worktrees/<repo>/<branch>`, copies
untracked `.env` files, and runs the repo's package install.

## Before you start

1. Run `wt -v`. If the command is missing, ask the user before you install it
   with `npm install -g @gitsoufiane/wt`.
2. Run commands from inside the target repo, or pass `--cwd <repo>`.

## Rules

- Always pass `--json` to create and delete. stdout is then one JSON object;
  status lines go to stderr.
- Never use `--shell` or `-s`. They need an interactive terminal.
- A command cannot change your shell directory. Use the `path` from the JSON
  in later commands, for example `cd <path> && ...` or `git -C <path> ...`.
- Add `--no-install` when the task does not need dependencies.
- Add `--no-env` when the task must not get local secrets.

## Create

```sh
wt --json --no-install feature-a
# {"path":"/home/me/.worktrees/repo/feature-a","branch":"feature-a","base":"origin/main","envCopied":1}
```

If `origin/feature-a` exists, `wt` checks it out and tracks it. Otherwise it
branches from the configured base (`wt.base`, then the remote default branch).
If the branch already exists locally, `wt` fails and prints where it is.

## List

```sh
git worktree list --porcelain
```

## Delete

Deleting is destructive. Confirm with the user first, and say whether the
branch is kept.

```sh
wt --json -d feature-a   # remove worktree, keep branch
wt --json -D feature-a   # remove worktree and delete branch
```

- A dirty worktree fails. Do not add `--force` unless the user agrees to lose
  the uncommitted changes.
- `wt feature-a -D` also deletes a branch that has no worktree.
- Run `wt -p` to clean metadata for worktree folders that were deleted by hand.
