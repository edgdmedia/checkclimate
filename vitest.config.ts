import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The Worker's `env` does not exist in Node. Anything that reads
			// bindings imports this stub under test, and sets values per case.
			"cloudflare:workers": fileURLToPath(
				new URL("./test/support/workers-env.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "scripts/**/*.test.ts"],
	},
});
