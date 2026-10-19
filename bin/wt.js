#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
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
const VERSION = require("../package.json").version;
const startedAt = Date.now();

const tty = Boolean(process.stderr.isTTY) && process.env.TERM !== "dumb";
const useColor = tty && !("NO_COLOR" in process.env);
// Spinners redraw one line, so they need a real terminal; CI logs get plain lines.
const animate = tty && !process.env.CI;
const paint = (code) => (text) =>
	useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text);
const c = {
	bold: paint(1),
	dim: paint(2),
	red: paint(31),
	green: paint(32),
	yellow: paint(33),
	magenta: paint(35),
	cyan: paint(36),
};
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let cursorHidden = false;
process.on("exit", () => {
	if (cursorHidden) process.stderr.write("\x1b[?25h");
});

(async () => {
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
	await main(args);
})().catch((error) => {
	console.error(`${c.red("✖ wt:")} ${error.message}`);
	process.exit(1);
});

async function main(argv) {
	const cmd = argv[0] || "";

	if (cmd === "" || cmd === "-h" || cmd === "--help") {
		usage();
		return;
	}

	if (cmd === "-v" || cmd === "--version") {
		console.log(VERSION);
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
	return createWorktree(cmd);
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

async function createWorktree(name) {
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

	header(`creating worktree ${c.bold(c.magenta(name))}`);
	detail("📦", "repo", mainRepoRoot(repo));
	detail("📁", "target", wtPath);

	const base = await resolveBaseRef(repo, name);
	detail(
		"🌱",
		"base",
		`${c.cyan(base.ref)}${base.track ? c.dim(" (tracking remote branch)") : ""}`,
	);
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });

	const add = await step(
		`🌿 Creating branch '${name}' from ${base.ref}`,
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
		throw new Error(`worktree creation failed at ${wtPath}`);
	}
	if (add.status !== 0)
		warn(
			`git worktree add exited ${add.status}, but ${wtPath} exists; continuing`,
		);

	let envCopied = 0;
	if (flags.env && copyEnvEnabled(repo)) {
		envCopied = copyEnvFiles(repo, wtPath);
	} else {
		log("🙈", "env copy skipped");
	}

	await runSetup(repo, wtPath);
	done(`Worktree ${c.bold(name)} is ready`);
	finishTarget(wtPath, { branch: name, base: base.ref, envCopied });
}

function listWorktrees() {
	const repo = repoRoot();
	header("worktrees");
	run("git", ["-C", repo, "worktree", "list"], { stdio: "inherit" });
}

function pruneWorktrees() {
	const repo = repoRoot();
	header("pruning stale worktree metadata");
	log("🔍", "previewing prunable worktree metadata");
	run("git", ["-C", repo, "worktree", "prune", "--verbose", "--dry-run"], {
		stdio: "inherit",
	});
	log("🧹", "pruning");
	run("git", ["-C", repo, "worktree", "prune", "--verbose"], {
		stdio: "inherit",
	});
	done("Prune finished");
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

async function deleteWorktree(deleteBranch, name) {
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
		header(`deleting branch ${c.bold(c.magenta(name))}`);
		await step(`🔥 Deleting branch '${name}'`, "git", [
			"-C",
			main,
			"branch",
			"-D",
			name,
		]);
		done(`Branch ${c.bold(name)} deleted`);
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
	header(`deleting worktree ${c.bold(c.magenta(branch))}`);
	detail("📁", "path", current);
	detail("📦", "repo", main);
	if (dirty) warn("discarding uncommitted changes (--force)");

	// cwd must be main: process.cwd() is deleted by the remove below
	const removeArgs = ["-C", main, "worktree", "remove"];
	if (flags.force) removeArgs.push("--force");
	await step(
		`🧹 Removing worktree ${current}`,
		"git",
		[...removeArgs, current],
		{
			cwd: main,
		},
	);

	if (deleteBranch) {
		if (branch === "HEAD") {
			warn("detached HEAD; no branch to delete");
		} else {
			await step(
				`🔥 Deleting branch '${branch}'`,
				"git",
				["-C", main, "branch", "-D", branch],
				{ cwd: main },
			);
		}
	} else {
		log("🔒", `branch '${branch}' kept`);
	}
	done("Worktree deleted");

	if (flags.json) console.log(JSON.stringify({ path: main, branch }));
	else console.log(`cd ${shellQuote(main)}`);
}

function syncEnv() {
	const current = repoRoot();
	const main = mainRepoRoot(current);
	if (samePath(current, main))
		throw new Error("run sync-env inside a linked worktree, not the main repo");
	header("syncing env files");
	detail("📦", "from", main);
	detail("📁", "to", current);
	const count = copyEnvFiles(main, current);
	done(`Synced ${count} env file(s)`);
}

async function resolveBaseRef(repo, name) {
	const configured = config(repo, "wt.base", "WT_BASE", "");
	const remote = config(repo, "wt.remote", "WT_REMOTE", "origin");
	const hasRemote = gitOk(["remote", "get-url", remote], repo);
	const remoteRefExists = (branch) =>
		gitOk(
			["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
			repo,
		);

	if (hasRemote) {
		const fetch = await step(
			`🛰️  Fetching latest ${remote}`,
			"git",
			["-C", repo, "fetch", remote, "--prune"],
			{ check: false },
		);
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

async function runSetup(repo, wtPath) {
	if (!flags.install || process.env.WT_SKIP_HOOK === "1") {
		log("⏭️ ", "setup skipped");
		return;
	}

	const hook = config(repo, "wt.hook", "WT_HOOK", "");
	if (hook) {
		await step(`🪝 Running hook: ${hook}`, hook, [], {
			cwd: wtPath,
			shell: true,
		});
		return;
	}

	const install = detectInstall(wtPath);
	if (!install) {
		log("⏭️ ", "no hook or installable manifest; skipping setup");
		return;
	}

	// Via the shell so Windows can run npm.cmd etc. (Node blocks direct .cmd spawns).
	await step(`📦 Installing dependencies (${install})`, install, [], {
		cwd: wtPath,
		shell: true,
	});
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
		log("🔐", `copied ${c.cyan(rel)}`);
		count += 1;
	}

	if (count === 0) log("🔐", "no env files to copy");
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

// Runs a child with a spinner. On a terminal the output is captured and its
// last line is shown next to the spinner; elsewhere it streams to stderr.
// Child output never reaches stdout, which carries only wt's result.
function step(label, cmd, cmdArgs = [], options = {}) {
	const started = Date.now();
	const stdio = ["inherit", "pipe", "pipe"];
	const cwd = options.cwd || process.cwd();
	const child = options.shell
		? spawn(cmd, { cwd, shell: true, stdio })
		: spawn(cmd, cmdArgs, { cwd, stdio });
	const command = options.shell ? cmd : [cmd, ...cmdArgs].join(" ");
	let output = "";
	let last = "";
	const spinner = startSpinner(label, started, () => last);

	const collect = (chunk) => {
		const text = chunk.toString();
		output += text;
		if (!animate) process.stderr.write(text);
		const lines = stripAnsi(text)
			.split(/[\r\n]+/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length) last = lines[lines.length - 1];
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	return new Promise((resolve, reject) => {
		let settled = false;
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			spinner.stop("fail");
			reject(new Error(`${cmd}: ${error.message}`));
		});
		child.on("close", (status) => {
			if (settled) return;
			settled = true;
			const result = { status };
			if (status === 0) {
				spinner.stop("ok");
				return resolve(result);
			}
			spinner.stop(options.check === false ? "warn" : "fail");
			// Captured output was hidden behind the spinner; show it now.
			if (animate && output.trim()) {
				console.error(
					c.dim(
						output
							.trim()
							.split("\n")
							.map((line) => `   │ ${line}`)
							.join("\n"),
					),
				);
			}
			if (options.check === false) return resolve(result);
			reject(new Error(`${command} failed with exit ${status}`));
		});
	});
}

function startSpinner(label, started, lastLine) {
	const finish = (state) => {
		const icon = { ok: c.green("✔"), warn: c.yellow("⚠"), fail: c.red("✖") }[
			state
		];
		console.error(`${icon} ${label} ${c.dim(`(${elapsed(started)})`)}`);
	};
	if (!animate) {
		console.error(`${c.cyan("⏳")} ${label}...`);
		return { stop: finish };
	}

	let frame = 0;
	const render = () => {
		const spin = c.cyan(FRAMES[frame++ % FRAMES.length]);
		let text = `${spin} ${label} ${c.dim(elapsed(started))}`;
		const room = (process.stderr.columns || 80) - stripAnsi(text).length - 6;
		const extra = lastLine();
		if (extra && room > 10)
			text += c.dim(
				`  ${extra.length > room ? `${extra.slice(0, room - 1)}…` : extra}`,
			);
		process.stderr.write(`\r\x1b[2K${text}`);
	};
	cursorHidden = true;
	process.stderr.write("\x1b[?25l");
	render();
	const timer = setInterval(render, 80);
	return {
		stop(state) {
			clearInterval(timer);
			process.stderr.write("\r\x1b[2K\x1b[?25h");
			cursorHidden = false;
			finish(state);
		},
	};
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

	log("🐚", `opening shell in ${target}`);
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

function header(title) {
	console.error(
		`\n🌳 ${c.bold(c.green("wt"))} ${c.dim(`v${VERSION}`)}  ${title}\n`,
	);
}

function detail(icon, key, value) {
	console.error(`   ${icon} ${c.dim(key.padEnd(7))} ${value}`);
}

function done(message) {
	console.error(
		`\n✨ ${c.bold(c.green(message))} ${c.dim(`in ${elapsed(startedAt)}`)}\n`,
	);
}

function log(icon, message) {
	console.error(`${icon} ${message}`);
}

function warn(message) {
	console.error(`${c.yellow("⚠️  wt:")} ${message}`);
}

function elapsed(since) {
	const ms = Date.now() - since;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
