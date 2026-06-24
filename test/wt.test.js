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
		assert.match(result.stdout, new RegExp(escapeRegExp(wtPath)));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
