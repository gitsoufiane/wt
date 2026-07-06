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
