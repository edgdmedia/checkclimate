/**
 * Run a command with the project's local environment in `process.env`.
 *
 * Astro/Vite put `.env` values on `import.meta.env`, not on `process.env`, and
 * this app's runtime config (`src/runtime.ts`) and `astro.config.mjs` read
 * `process.env` — the way they must, because on the box the environment comes
 * from systemd's `EnvironmentFile`, where `import.meta.env` does not exist.
 *
 * So local dev goes through this wrapper: it loads `.env`, `.env.local` and
 * `.env.vps.local` (box-shaped values for testing the SQLite/S3 path on the
 * laptop) into the process environment, then spawns the command. Nothing is
 * printed, and real environment variables always win over the files.
 *
 * Usage: node scripts/with-env.mjs astro dev
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const files = [".env", ".env.local", ".env.vps.local"];

/** Minimal dotenv parser: KEY=VALUE, optional quotes, # comments. */
function parseEnv(text) {
	const out = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

const fileEnv = {};
for (const file of files) {
	const path = resolve(root, file);
	if (!existsSync(path)) continue;
	Object.assign(fileEnv, parseEnv(readFileSync(path, "utf8")));
}

const env = { ...fileEnv, ...process.env };

const [command, ...args] = process.argv.slice(2);
if (!command) {
	console.error("Usage: node scripts/with-env.mjs <command> [...args]");
	process.exit(1);
}

const child = spawn(command, args, {
	stdio: "inherit",
	env,
	shell: process.platform === "win32",
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
child.on("error", (error) => {
	console.error(error);
	process.exit(1);
});