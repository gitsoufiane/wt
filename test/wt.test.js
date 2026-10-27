const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bin = path.join(__dirname, "..", "bin", "wt.js");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) throw result.error;
	return result;
}

function git(args, cwd) {
	const result = run("git", args, { cwd });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

function makeRepo(root) {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	git(["init", "-q"], repo);
	git(["config", "user.email", "wt@example.test"], repo);
	git(["config", "user.name", "wt test"], repo);
	fs.writeFileSync(path.join(repo, "README.md"), "test\n");
	git(["add", "README.md"], repo);
	git(["commit", "-qm", "init"], repo);
	return repo;
}

test("prints help", () => {
	const result = run("node", [bin, "--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /usage: wt/);
});

test("creates a worktree from a local repo and copies env files", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		const wtRoot = path.join(tmp, "worktrees");
		fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");

		const result = run("node", [bin, "feature-a"], {
			cwd: repo,
			env: { ...process.env, WT_ROOT: wtRoot, WT_SKIP_HOOK: "1" },
		});

		assert.equal(result.status, 0, result.stderr || result.stdout);
		const wtPath = path.join(wtRoot, "feature-a");
		assert.ok(fs.existsSync(path.join(wtPath, ".git")));
		assert.equal(
			fs.readFileSync(path.join(wtPath, ".env"), "utf8"),
			"SECRET=1\n",
		);
		assert.ok(result.stdout.includes(wtPath));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("--json and --no-env produce machine-readable output", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		const wtRoot = path.join(tmp, "worktrees");
		fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");

		const result = run(
			"node",
			[bin, "--json", "--no-env", "--no-install", "--cwd", repo, "feature-b"],
			{ env: { ...process.env, WT_ROOT: wtRoot } },
		);

		assert.equal(result.status, 0, result.stderr || result.stdout);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.path, path.join(wtRoot, "feature-b"));
		assert.equal(parsed.branch, "feature-b");
		assert.equal(parsed.envCopied, 0);
		assert.ok(!fs.existsSync(path.join(parsed.path, ".env")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("-D deletes the current worktree and its branch", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		const wtRoot = path.join(tmp, "worktrees");
		const env = { ...process.env, WT_ROOT: wtRoot, WT_SKIP_HOOK: "1" };

		run("node", [bin, "feature-c"], { cwd: repo, env });
		const wtPath = path.join(wtRoot, "feature-c");

		const result = run("node", [bin, "-D"], { cwd: wtPath, env });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.ok(!fs.existsSync(wtPath));
		const branches = git(["branch", "--list", "feature-c"], repo);
		assert.equal(branches, "");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("existing branch reports its worktree and supports targeted -D", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		const wtRoot = path.join(tmp, "worktrees");
		const env = { ...process.env, WT_ROOT: wtRoot, WT_SKIP_HOOK: "1" };

		run("node", [bin, "feature-d"], { cwd: repo, env });
		const wtPath = path.join(wtRoot, "feature-d");

		const conflict = run("node", [bin, "feature-d"], { cwd: repo, env });
		assert.equal(conflict.status, 1);
		assert.ok(conflict.stderr.includes(wtPath));
		assert.match(conflict.stderr, /wt 'feature-d' -D/);

		const result = run("node", [bin, "feature-d", "-D"], { cwd: repo, env });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.ok(!fs.existsSync(wtPath));
		const branches = git(["branch", "--list", "feature-d"], repo);
		assert.equal(branches, "");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("targeted -D deletes a branch without a worktree", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		git(["branch", "feature-e"], repo);

		const conflict = run("node", [bin, "feature-e"], { cwd: repo });
		assert.equal(conflict.status, 1);
		assert.match(conflict.stderr, /wt 'feature-e' -D/);

		const result = run("node", [bin, "feature-e", "-D"], { cwd: repo });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(git(["branch", "--list", "feature-e"], repo), "");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("skips setup when a lockfile has no package.json", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
		git(["add", "package-lock.json"], repo);
		git(["commit", "-qm", "lockfile"], repo);

		const result = run("node", [bin, "feature-f"], {
			cwd: repo,
			env: { ...process.env, WT_ROOT: path.join(tmp, "worktrees") },
		});

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stderr, /skipping setup/);
		assert.doesNotMatch(result.stderr, /npm install/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("-D refuses a dirty worktree unless --force is given", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		const wtRoot = path.join(tmp, "worktrees");
		const env = { ...process.env, WT_ROOT: wtRoot, WT_SKIP_HOOK: "1" };

		run("node", [bin, "feature-g"], { cwd: repo, env });
		const wtPath = path.join(wtRoot, "feature-g");
		fs.writeFileSync(path.join(wtPath, "README.md"), "dirty\n");

		const refused = run("node", [bin, "feature-g", "-D"], { cwd: repo, env });
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /--force/);
		assert.ok(fs.existsSync(wtPath));

		const forced = run("node", [bin, "--force", "feature-g", "-D"], {
			cwd: repo,
			env,
		});
		assert.equal(forced.status, 0, forced.stderr || forced.stdout);
		assert.ok(!fs.existsSync(wtPath));
		assert.equal(git(["branch", "--list", "feature-g"], repo), "");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

function withRepo(fn) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
	try {
		const repo = makeRepo(tmp);
		const wtRoot = path.join(tmp, "worktrees");
		const env = { ...process.env, WT_ROOT: wtRoot, WT_SKIP_HOOK: "1" };
		fn({ tmp, repo, wtRoot, env });
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

test("-D <name> deletes the named worktree, not the current one", () => {
	withRepo(({ repo, wtRoot, env }) => {
		run("node", [bin, "feature-h"], { cwd: repo, env });
		run("node", [bin, "feature-i"], { cwd: repo, env });
		const current = path.join(wtRoot, "feature-i");

		const result = run("node", [bin, "-D", "feature-h"], { cwd: current, env });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.ok(!fs.existsSync(path.join(wtRoot, "feature-h")));
		assert.ok(fs.existsSync(current));
		git(["show-ref", "--verify", "--quiet", "refs/heads/feature-i"], repo);
	});
});

test("-d <name> deletes the named worktree and keeps the branch", () => {
	withRepo(({ repo, wtRoot, env }) => {
		run("node", [bin, "feature-j"], { cwd: repo, env });
		const result = run("node", [bin, "-d", "feature-j"], { cwd: repo, env });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.ok(!fs.existsSync(path.join(wtRoot, "feature-j")));
		assert.equal(git(["branch", "--list", "feature-j"], repo), "feature-j");
	});
});

test("--json stdout stays pure JSON when git prints output", () => {
	withRepo(({ repo, env }) => {
		git(["branch", "feature-k"], repo);
		const result = run("node", [bin, "--json", "feature-k", "-D"], {
			cwd: repo,
			env,
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(JSON.parse(result.stdout), {
			path: fs.realpathSync(repo),
			branch: "feature-k",
		});
	});
});

test("default root uses the main repo name from inside a linked worktree", () => {
	withRepo(({ tmp, repo }) => {
		const home = path.join(tmp, "home");
		const env = { ...process.env, HOME: home, WT_SKIP_HOOK: "1" };
		delete env.WT_ROOT;
		run("node", [bin, "feature-l"], { cwd: repo, env });
		const first = path.join(home, ".worktrees", "repo", "feature-l");
		assert.ok(fs.existsSync(first));

		const result = run("node", [bin, "--json", "feature-m"], {
			cwd: first,
			env,
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(
			JSON.parse(result.stdout).path,
			path.join(home, ".worktrees", "repo", "feature-m"),
		);
	});
});

test("tracks a same-named remote branch and survives a failed fetch", () => {
	withRepo(({ tmp, repo, wtRoot, env }) => {
		const origin = path.join(tmp, "origin.git");
		git(["init", "-q", "--bare", origin], tmp);
		git(["remote", "add", "origin", origin], repo);
		git(["push", "-q", "origin", "HEAD:refs/heads/main"], repo);
		git(["commit", "-q", "--allow-empty", "-m", "remote work"], repo);
		git(["push", "-q", "origin", "HEAD:refs/heads/shared"], repo);
		const remoteTip = git(["rev-parse", "HEAD"], repo);
		git(["reset", "-q", "--hard", "HEAD~1"], repo);
		git(["fetch", "-q", "origin"], repo);

		const tracked = run("node", [bin, "--json", "shared"], { cwd: repo, env });
		assert.equal(tracked.status, 0, tracked.stderr || tracked.stdout);
		assert.equal(JSON.parse(tracked.stdout).base, "origin/shared");
		const wtPath = path.join(wtRoot, "shared");
		assert.equal(git(["rev-parse", "HEAD"], wtPath), remoteTip);
		assert.equal(
			git(["rev-parse", "--abbrev-ref", "@{u}"], wtPath),
			"origin/shared",
		);

		git(["remote", "set-url", "origin", path.join(tmp, "missing.git")], repo);
		const offline = run("node", [bin, "feature-n"], { cwd: repo, env });
		assert.equal(offline.status, 0, offline.stderr || offline.stdout);
		assert.match(offline.stderr, /fetch from origin failed/);
	});
});

test("-D cleans up a worktree whose folder was deleted by hand", () => {
	withRepo(({ repo, wtRoot, env }) => {
		run("node", [bin, "feature-o"], { cwd: repo, env });
		fs.rmSync(path.join(wtRoot, "feature-o"), { recursive: true });

		const result = run("node", [bin, "-D", "feature-o"], { cwd: repo, env });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(git(["branch", "--list", "feature-o"], repo), "");
		assert.doesNotMatch(git(["worktree", "list"], repo), /feature-o/);
	});
});

test("unknown options keep stdout empty", () => {
	const result = run("node", [bin, "--json", "--bogus"]);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /unknown option '--bogus'/);
});

test("--cwd reports a missing directory clearly", () => {
	const result = run("node", [bin, "--cwd", "/no/such/dir", "x"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--cwd: no such directory: \/no\/such\/dir/);
});

test("refuses to delete the branch of the main worktree", () => {
	withRepo(({ repo, env }) => {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
		const result = run("node", [bin, "-D", branch], { cwd: repo, env });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /main worktree/);
	});
});

test("--base and --root flags override the defaults", () => {
	withRepo(({ tmp, repo, env }) => {
		const first = git(["rev-parse", "HEAD"], repo);
		git(["commit", "-q", "--allow-empty", "-m", "second"], repo);
		const root = path.join(tmp, "flag-root");

		const result = run(
			"node",
			[bin, "--json", "--base=HEAD~1", "--root", root, "feature-p"],
			{ cwd: repo, env },
		);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.path, path.join(root, "feature-p"));
		assert.equal(parsed.base, "HEAD~1");
		assert.equal(git(["rev-parse", "HEAD"], parsed.path), first);
	});
});

test("-l --json lists worktrees as JSON", () => {
	withRepo(({ repo, wtRoot, env }) => {
		run("node", [bin, "feature-q"], { cwd: repo, env });
		fs.writeFileSync(path.join(wtRoot, "feature-q", "new.txt"), "x\n");

		const result = run("node", [bin, "-l", "--json"], { cwd: repo, env });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const list = JSON.parse(result.stdout);
		assert.equal(list.length, 2);
		assert.equal(list[0].main, true);
		const entry = list.find((item) => item.branch === "feature-q");
		assert.equal(entry.path, fs.realpathSync(path.join(wtRoot, "feature-q")));
		assert.equal(entry.dirty, true);
		assert.equal(entry.main, false);
	});
});

test("shell-init prints a cd helper function", () => {
	const result = run("node", [bin, "shell-init"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^wtc\(\) \{/m);
});
