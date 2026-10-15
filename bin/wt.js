#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rawArgs = process.argv.slice(2);
const flags = {
	shell: false,
	json: false,
	install: true,
	env: true,
	force: false,
};
const args = [];
// Child output goes to stderr so stdout carries only wt's result (path or JSON).
const CHILD_STDIO = ["inherit", 2, "inherit"];

try {
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--shell") flags.shell = true;
		else if (arg === "--json") flags.json = true;
		else if (arg === "--no-install") flags.install = false;
		else if (arg === "--no-env") flags.env = false;
		else if (arg === "--force") flags.force = true;
		else if (arg === "--cwd") {
			const dir = rawArgs[++i];
			if (!dir) throw new Error("--cwd requires a directory");
			process.chdir(dir);
		} else args.push(arg);
	}
	main(args);
} catch (error) {
	console.error(`wt: ${error.message}`);
	process.exit(1);
}

function main(argv) {
	const cmd = argv[0] || "";

	if (cmd === "" || cmd === "-h" || cmd === "--help") {
		usage();
		return;
	}

	if (cmd === "-v" || cmd === "--version") {
		console.log(require("../package.json").version);
		return;
	}

	if (cmd === "-l" || cmd === "--list") return listWorktrees();
	if (cmd === "-p" || cmd === "--prune") return pruneWorktrees();
	if (cmd === "-s" || cmd === "--switch") return switchWorktree();
	if (cmd === "sync-env") return syncEnv();

	const deleteFlags = { "-d": false, "--delete": false, "-D": true };
	if (Object.hasOwn(deleteFlags, cmd)) {
		if (argv.length > 2)
			throw new Error(
				`'${cmd}' takes at most one name, got ${argv.length - 1}`,
			);
		return deleteWorktree(deleteFlags[cmd], argv[1]);
	}
	if (argv.length === 2 && Object.hasOwn(deleteFlags, argv[1]))
		return deleteWorktree(deleteFlags[argv[1]], cmd);

	if (cmd.startsWith("-")) {
		usage();
		throw new Error(`unknown option '${cmd}'`);
	}

	if (argv.length !== 1)
		throw new Error(`create takes exactly one name, got ${argv.length}`);
	createWorktree(cmd);
}

function usage() {
	console.log(`usage: wt [options] <name> | wt [-d|-D] [<name>] | wt -s | wt -l | wt -p | wt sync-env

  <name>        create worktree; tracks <remote>/<name> if it exists,
                else branches from the configured base ref
  --shell       open a subshell in the target after create or switch
  --json        print machine-readable JSON instead of text output
  --cwd <dir>   run as if started in <dir>
  --no-install  skip the setup hook / package install
  --no-env      skip copying .env files
  --force       discard uncommitted changes when deleting a worktree
  -s            switch: fzf-pick an existing worktree and print its path
  -l            list worktrees
  -p            prune stale worktree metadata
  -d [<name>]   delete current (or named) worktree, keep branch
  -D [<name>]   delete current (or named) worktree and its branch
  <name> -D     same as -D <name>; also deletes a branch with no worktree
  sync-env      copy untracked .env files from main repo to current worktree
  -v            print version`);
}

function createWorktree(name) {
	const repo = repoRoot();
	validateBranchName(name, repo);

	if (gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], repo)) {
		const existing = findWorktree(repo, name);
		const location = existing ? ` at ${existing.worktree}` : "";
		const removal =
			!existing || !samePath(existing.worktree, mainRepoRoot(repo))
				? `\nremove it with: wt ${shellQuote(name)} -D`
				: "";
		throw new Error(`branch '${name}' already exists${location}${removal}`);
	}

	const root = worktreeRoot(repo);
	const wtPath = path.resolve(root, name);
	ensureInside(root, wtPath);

	if (fs.existsSync(wtPath)) throw new Error(`${wtPath} already exists`);

	const base = resolveBaseRef(repo, name);
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });

	log(`creating '${name}' from ${base.ref}`);
	const add = run(
		"git",
		[
			"-C",
			repo,
			"worktree",
			"add",
			base.track ? "--track" : "--no-track",
			"-b",
			name,
			wtPath,
			base.ref,
		],
		{ check: false },
	);
	if (!fs.existsSync(path.join(wtPath, ".git"))) {
		throw new Error(`worktree creation failed at ${wtPath}${outputTail(add)}`);
	}
	if (add.status !== 0)
		warn(
			`git worktree add exited ${add.status}, but ${wtPath} exists; continuing`,
		);

	let envCopied = 0;
	if (flags.env && copyEnvEnabled(repo)) {
		envCopied = copyEnvFiles(repo, wtPath);
		log(`copied ${envCopied} env file(s) -> ${wtPath}`);
	}

	runSetup(repo, wtPath);
	log(`created ${wtPath}`);
	finishTarget(wtPath, { branch: name, base: base.ref, envCopied });
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

function switchWorktree() {
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

	finishTarget(target, {});
}

function deleteWorktree(deleteBranch, name) {
	const source = repoRoot();
	const main = mainRepoRoot(source);
	if (name) validateBranchName(name, source);
	const existing = name && findWorktree(source, name);
	const current = existing ? existing.worktree : source;

	if (name && !existing) {
		if (!deleteBranch)
			throw new Error(`no worktree has branch '${name}' checked out`);
		if (!gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], main))
			throw new Error(`branch '${name}' does not exist`);
		run("git", ["-C", main, "branch", "-D", name], { stdio: CHILD_STDIO });
		log(`deleted branch '${name}'`);
		if (flags.json) console.log(JSON.stringify({ path: main, branch: name }));
		else console.log(`cd ${shellQuote(main)}`);
		return;
	}
	if (isMainWorktree(current)) throw new Error("not inside a linked worktree");

	const dirty = git(["status", "--porcelain"], current);
	if (dirty && !flags.force)
		throw new Error(
			`working tree is dirty; commit, stash, or discard changes first, or re-run with --force\n${dirty}`,
		);

	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], current);
	// cwd must be main: process.cwd() is deleted by the remove below
	const removeArgs = ["-C", main, "worktree", "remove"];
	if (flags.force) removeArgs.push("--force");
	run("git", [...removeArgs, current], {
		cwd: main,
		stdio: CHILD_STDIO,
	});
	log(`removed ${current}`);

	if (deleteBranch) {
		if (branch === "HEAD") {
			warn("detached HEAD; no branch to delete");
		} else {
			run("git", ["-C", main, "branch", "-D", branch], {
				cwd: main,
				stdio: CHILD_STDIO,
			});
			log(`deleted branch '${branch}'`);
		}
	} else {
		log(`branch '${branch}' kept`);
	}

	if (flags.json) console.log(JSON.stringify({ path: main, branch }));
	else console.log(`cd ${shellQuote(main)}`);
}

function syncEnv() {
	const current = repoRoot();
	const main = mainRepoRoot(current);
	if (samePath(current, main))
		throw new Error("run sync-env inside a linked worktree, not the main repo");
	const count = copyEnvFiles(main, current);
	log(`synced ${count} env file(s) into ${current}`);
}

function resolveBaseRef(repo, name) {
	const configured = config(repo, "wt.base", "WT_BASE", "");
	const remote = config(repo, "wt.remote", "WT_REMOTE", "origin");
	const hasRemote = gitOk(["remote", "get-url", remote], repo);
	const remoteRefExists = (branch) =>
		gitOk(
			["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
			repo,
		);

	if (hasRemote) {
		log(`fetching latest ${remote}`);
		const fetch = run("git", ["-C", repo, "fetch", remote, "--prune"], {
			stdio: CHILD_STDIO,
			check: false,
		});
		if (fetch.status !== 0)
			warn(`fetch from ${remote} failed; using local refs, which may be stale`);
	}

	// Same-named remote branch: check it out instead of creating a diverging one.
	if (hasRemote && remoteRefExists(name))
		return { ref: `${remote}/${name}`, track: true };
	if (configured) return { ref: configured, track: false };
	if (!hasRemote) return { ref: "HEAD", track: false };

	const remoteHead = gitMaybe(
		["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
		repo,
	);
	if (remoteHead.ok && remoteHead.stdout.trim())
		return { ref: remoteHead.stdout.trim(), track: false };

	for (const branch of ["this", "main", "master"]) {
		if (remoteRefExists(branch))
			return { ref: `${remote}/${branch}`, track: false };
	}

	return { ref: "HEAD", track: false };
}

function runSetup(repo, wtPath) {
	if (!flags.install || process.env.WT_SKIP_HOOK === "1") {
		log("setup skipped");
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
		log("no hook or installable manifest; skipping setup");
		return;
	}

	log(`running ${install}`);
	// Via the shell so Windows can run npm.cmd etc. (Node blocks direct .cmd spawns).
	runShell(install, wtPath);
}

function detectInstall(dir) {
	if (!fs.existsSync(path.join(dir, "package.json"))) return null;
	if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm install";
	if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn install";
	if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm install";
	if (
		fs.existsSync(path.join(dir, "bun.lock")) ||
		fs.existsSync(path.join(dir, "bun.lockb"))
	)
		return "bun install";
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
		configured ||
		path.join(os.homedir(), ".worktrees", path.basename(mainRepoRoot(repo)));
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

function findWorktree(repo, branch) {
	return parseWorktrees(git(["worktree", "list", "--porcelain"], repo)).find(
		(entry) => entry.branch === branch,
	);
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
		stdio: CHILD_STDIO,
	});
	if (result.error) throw new Error(`${command}: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(`${command} failed with exit ${result.status}`);
}

function commandExists(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

function finishTarget(target, extra) {
	if (flags.json) {
		console.log(JSON.stringify({ path: target, ...extra }));
		return;
	}

	if (!flags.shell) {
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
	console.error(`wt: ${message}`);
}

function warn(message) {
	console.error(`wt: ${message}`);
}
