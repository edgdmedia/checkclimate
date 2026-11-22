/**
 * Stand-in for the `cloudflare:workers` module under vitest.
 *
 * Aliased in vitest.config.ts. The real module is a frozen-ish view of the
 * Worker's bindings; this is a plain object tests can rewrite between cases.
 */
export const env: Record<string, string> = {};

export const ctx = {
	waitUntil(promise: Promise<unknown>): void {
		void promise;
	},
	passThroughOnException(): void {},
};

/** Sets (or, with undefined, deletes) environment values for the next case. */
export function setEnv(values: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
}

export default { env, ctx, setEnv };
