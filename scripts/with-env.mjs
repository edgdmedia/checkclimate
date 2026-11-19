/**
 * Run a command with the project's local environment loaded.
 *
 * Wrangler reads `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` from
 * `process.env`, but neither Astro nor Vite copies `.env` into the process
 * environment. This wrapper loads `.env`, `.env.local` and `.dev.vars`, maps
 * `NEON_DEV_DATABASE_URL` onto both Hyperdrive bindings, then spawns the command
 * with the merged environment.
 *
 * Usage: node scripts/with-env.mjs astro dev
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const files = [".env", ".env.local", ".dev.vars"];

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

const neonDev = env.NEON_DEV_DATABASE_URL;
if (neonDev) {
	// Both bindings point at the same database locally; Hyperdrive pooling and
	// query caching do not apply in local development anyway.
	env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = neonDev;
	env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED = neonDev;
}

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