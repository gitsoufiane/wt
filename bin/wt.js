#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rawArgs = process.argv.slice(2);
const shellMode = rawArgs.includes("--shell");
const args = rawArgs.filter((arg) => arg !== "--shell");

try {
	main(args, shellMode);
} catch (error) {
	console.error(`wt: ${error.message}`);
	process.exit(1);
}

function main(argv, openShell) {
	const cmd = argv[0] || "";

	if (cmd === "" || cmd === "-h" || cmd === "--help") {
		usage();
		return;
	}

	if (cmd === "-l" || cmd === "--list") return listWorktrees();
	if (cmd === "-p" || cmd === "--prune") return pruneWorktrees();
	if (cmd === "-s" || cmd === "--switch") return switchWorktree(openShell);
	if (cmd === "-d" || cmd === "--delete") return deleteWorktree(false);
	if (cmd === "-D") return deleteWorktree(true);
	if (cmd === "sync-env") return syncEnv();

	if (cmd.startsWith("-")) {
		usage();
		throw new Error(`unknown option '${cmd}'`);
	}

	if (argv.length !== 1)
		throw new Error(`create takes exactly one name, got ${argv.length}`);
	createWorktree(cmd, openShell);
}

function usage() {
	console.log(`usage: wt [--shell] <name> | wt -s | wt -l | wt -p | wt -d | wt -D | wt sync-env

  <name>    create worktree from the configured base ref
  --shell   open a subshell in the target after create or switch
  -s        switch: fzf-pick an existing worktree and print its path
  -l        list worktrees
  -p        prune stale worktree metadata
  -d        delete current worktree, keep branch
  -D        delete current worktree and its branch
  sync-env  copy untracked .env files from main repo to current worktree`);
}

function createWorktree(name, openShell) {
	const repo = repoRoot();
	validateBranchName(name, repo);

	if (gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], repo)) {
		throw new Error(`branch '${name}' already exists`);
	}

	const root = worktreeRoot(repo);
	const wtPath = path.resolve(root, name);
	ensureInside(root, wtPath);

	if (fs.existsSync(wtPath)) throw new Error(`${wtPath} already exists`);

	const baseRef = resolveBaseRef(repo);
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });

	const add = run(
		"git",
		["-C", repo, "worktree", "add", "--no-track", "-b", name, wtPath, baseRef],
		{ check: false },
	);
	if (!fs.existsSync(path.join(wtPath, ".git"))) {
		throw new Error(`worktree creation failed at ${wtPath}${outputTail(add)}`);
	}
	if (add.status !== 0)
		warn(
			`git worktree add exited ${add.status}, but ${wtPath} exists; continuing`,
		);

	if (copyEnvEnabled(repo)) {
		const count = copyEnvFiles(repo, wtPath);
		log(`copied ${count} env file(s) -> ${wtPath}`);
	}

	runSetup(repo, wtPath);
	log(`created ${wtPath}`);
	finishTarget(wtPath, openShell);
}

function listWorktrees() {
	const repo = repoRoot();
	run("git", ["-C", repo, "worktree", "list"], { stdio: "inherit" });
}

function pruneWorktrees() {
	const repo = repoRoot();
	log("previewing prunable worktree metadata");
	run("git", ["-C", repo, "worktree", "prune", "--verbose", "--dry-run"], {
		stdio: "inherit",
	});
	log("pruning");
	run("git", ["-C", repo, "worktree", "prune", "--verbose"], {
		stdio: "inherit",
	});
	log("done");
}

function switchWorktree(openShell) {
	const repo = repoRoot();
	const entries = parseWorktrees(
		git(["worktree", "list", "--porcelain"], repo),
	);
	if (entries.length === 0) throw new Error("no worktrees found");

	let target;
	if (commandExists("fzf")) {
		const input = entries
			.map((entry) => `${entry.worktree}\t${entry.branch || ""}`)
			.join("\n");
		const pick = spawnSync("fzf", ["--prompt=worktree> "], {
			input,
			encoding: "utf8",
		});
		if (pick.error) throw new Error(`fzf: ${pick.error.message}`);
		if (pick.status !== 0 || !pick.stdout.trim()) return;
		target = pick.stdout.trimEnd().split("\t")[0];
	} else {
		for (const entry of entries) console.log(entry.worktree);
		throw new Error("fzf is not installed; copy one of the paths above");
	}

	finishTarget(target, openShell);
}

function deleteWorktree(deleteBranch) {
	const current = repoRoot();
	const main = mainRepoRoot(current);

	if (isMainWorktree(current)) throw new Error("not inside a linked worktree");

	const dirty = git(["status", "--porcelain"], current);
	if (dirty)
		throw new Error(
			`working tree is dirty; commit, stash, or discard changes first\n${dirty}`,
		);

	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], current);
	run("git", ["-C", main, "worktree", "remove", current], { stdio: "inherit" });
	log(`removed ${current}`);

	if (!deleteBranch) {
		log(`branch '${branch}' kept`);
		return;
	}

	if (branch === "HEAD") {
		warn("detached HEAD; no branch to delete");
		return;
	}

	run("git", ["-C", main, "branch", "-D", branch], { stdio: "inherit" });
	log(`deleted branch '${branch}'`);
}

function syncEnv() {
	const current = repoRoot();
	const main = mainRepoRoot(current);
	if (samePath(current, main))
		throw new Error("run sync-env inside a linked worktree, not the main repo");
	const count = copyEnvFiles(main, current);
	log(`synced ${count} env file(s) into ${current}`);
}

function resolveBaseRef(repo) {
	const configured = config(repo, "wt.base", "WT_BASE", "");
	const remote = config(repo, "wt.remote", "WT_REMOTE", "origin");
	const hasRemote = gitOk(["remote", "get-url", remote], repo);

	if (hasRemote) {
		log(`fetching latest ${remote}`);
		run("git", ["-C", repo, "fetch", remote, "--prune"], { stdio: "inherit" });
	}

	if (configured) return configured;
	if (!hasRemote) return "HEAD";

	const remoteHead = gitMaybe(
		["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
		repo,
	);
	if (remoteHead.ok && remoteHead.stdout.trim())
		return remoteHead.stdout.trim();

	for (const branch of ["this", "main", "master"]) {
		const ref = `refs/remotes/${remote}/${branch}`;
		if (gitOk(["show-ref", "--verify", "--quiet", ref], repo))
			return `${remote}/${branch}`;
	}

	return "HEAD";
}

function runSetup(repo, wtPath) {
	if (process.env.WT_SKIP_HOOK === "1") {
		log("setup skipped by WT_SKIP_HOOK=1");
		return;
	}

	const hook = config(repo, "wt.hook", "WT_HOOK", "");
	if (hook) {
		log(`running hook: ${hook}`);
		runShell(hook, wtPath);
		return;
	}

	const install = detectInstall(wtPath);
	if (!install) {
		log("no hook or lockfile; skipping setup");
		return;
	}

	log(`running ${[install.cmd, ...install.args].join(" ")}`);
	run(install.cmd, install.args, { cwd: wtPath, stdio: "inherit" });
}

function detectInstall(dir) {
	if (fs.existsSync(path.join(dir, "pnpm-lock.yaml")))
		return { cmd: "pnpm", args: ["install"] };
	if (fs.existsSync(path.join(dir, "yarn.lock")))
		return { cmd: "yarn", args: ["install"] };
	if (fs.existsSync(path.join(dir, "package-lock.json")))
		return { cmd: "npm", args: ["install"] };
	if (
		fs.existsSync(path.join(dir, "bun.lock")) ||
		fs.existsSync(path.join(dir, "bun.lockb"))
	)
		return { cmd: "bun", args: ["install"] };
	return null;
}

function copyEnvFiles(sourceRepo, targetRepo) {
	const result = run("git", [
		"-C",
		sourceRepo,
		"ls-files",
		"-z",
		"--others",
		"-x",
		"node_modules",
		"-x",
		"node_modules/**",
		"--",
		".env",
		".env.*",
		"**/.env",
		"**/.env.*",
	]);

	const files = result.stdout.split("\0").filter(Boolean);
	let count = 0;

	for (const rel of files) {
		if (!safeRel(rel)) continue;
		const source = path.join(sourceRepo, rel);
		const target = path.join(targetRepo, rel);
		if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
			fs.unlinkSync(target);
		fs.copyFileSync(source, target);
		count += 1;
	}

	return count;
}

function copyEnvEnabled(repo) {
	const value = config(repo, "wt.copyEnv", "WT_COPY_ENV", "true");
	return !/^(0|false|no)$/i.test(value);
}

function repoRoot(cwd = process.cwd()) {
	return git(["rev-parse", "--show-toplevel"], cwd);
}

function mainRepoRoot(cwd) {
	const common = git(["rev-parse", "--git-common-dir"], cwd);
	return path.dirname(path.resolve(cwd, common));
}

function isMainWorktree(cwd) {
	return samePath(
		absoluteGitDir(cwd),
		path.resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd)),
	);
}

function absoluteGitDir(cwd) {
	const result = gitMaybe(["rev-parse", "--absolute-git-dir"], cwd);
	if (result.ok) return result.stdout.trim();
	return path.resolve(cwd, git(["rev-parse", "--git-dir"], cwd));
}

function worktreeRoot(repo) {
	const configured = config(repo, "wt.root", "WT_ROOT", "");
	const value =
		configured || path.join(os.homedir(), ".worktrees", path.basename(repo));
	return path.resolve(repo, expandHome(value));
}

function config(repo, key, envKey, fallback) {
	if (process.env[envKey]) return process.env[envKey];
	const result = run("git", ["-C", repo, "config", "--get", key], {
		check: false,
	});
	return result.status === 0 ? result.stdout.trim() : fallback;
}

function validateBranchName(name, repo) {
	const result = run(
		"git",
		["-C", repo, "check-ref-format", "--branch", name],
		{ check: false },
	);
	if (result.status !== 0) throw new Error(`invalid branch name '${name}'`);
}

function parseWorktrees(output) {
	const entries = [];
	let entry = null;

	for (const line of output.split("\n")) {
		if (!line) {
			if (entry) entries.push(entry);
			entry = null;
			continue;
		}

		const space = line.indexOf(" ");
		const key = space === -1 ? line : line.slice(0, space);
		const value = space === -1 ? "" : line.slice(space + 1);
		if (key === "worktree") entry = { worktree: value };
		else if (entry && key === "branch")
			entry.branch = value.replace("refs/heads/", "");
	}

	if (entry) entries.push(entry);
	return entries;
}

function git(args, cwd) {
	return run("git", args, { cwd }).stdout.trim();
}

function gitOk(args, cwd) {
	return run("git", args, { cwd, check: false }).status === 0;
}

function gitMaybe(args, cwd) {
	const result = run("git", args, { cwd, check: false });
	return {
		ok: result.status === 0,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
	};
}

function run(cmd, cmdArgs = [], options = {}) {
	const result = spawnSync(cmd, cmdArgs, {
		cwd: options.cwd || process.cwd(),
		encoding: "utf8",
		stdio: options.stdio || "pipe",
	});

	if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
	if (options.check !== false && result.status !== 0) {
		throw new Error(
			`${[cmd, ...cmdArgs].join(" ")} failed${outputTail(result)}`,
		);
	}
	return result;
}

function runShell(command, cwd) {
	const result = spawnSync(command, {
		cwd,
		shell: true,
		stdio: "inherit",
	});
	if (result.error) throw new Error(`${command}: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(`${command} failed with exit ${result.status}`);
}

function commandExists(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

function finishTarget(target, openShell) {
	if (!openShell) {
		console.log(target);
		console.log(`cd ${shellQuote(target)}`);
		return;
	}

	log(`opening shell in ${target}`);
	const shell =
		process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "sh");
	const result = spawnSync(shell, {
		cwd: target,
		stdio: "inherit",
	});
	if (result.error) throw new Error(`${shell}: ${result.error.message}`);
	process.exitCode = result.status || 0;
}

function ensureInside(root, target) {
	const relative = path.relative(root, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`refusing path outside worktree root: ${target}`);
	}
}

function safeRel(rel) {
	return rel && !path.isAbsolute(rel) && !rel.split(/[\\/]+/).includes("..");
}

function samePath(a, b) {
	return path.resolve(a) === path.resolve(b);
}

function expandHome(value) {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function outputTail(result) {
	const text = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
	return text ? `\n${text}` : "";
}

function log(message) {
	console.log(`wt: ${message}`);
}

function warn(message) {
	console.error(`wt: ${message}`);
}
