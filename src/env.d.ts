/**
 * Ambient types for the Worker bindings and vars this app touches.
 *
 * `pnpm wrangler types` would generate complete types, but its global
 * `interface ImageMetadata` (Workers Images) collides with Astro's global
 * `type ImageMetadata` alias, and every `import logo from "./logo.png"`
 * starts reporting no `src`/`width`/`height`. Declaring just what we use
 * keeps both intact. Regenerate with wrangler types if you really want the
 * full surface, and drop this file at the same time.
 */
/// <reference types="astro/client" />

/** The R2 bucket behind the MEDIA binding (EmDash storage + claim uploads). */
interface R2BucketLike {
	put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
		options?: {
			httpMetadata?: { contentType?: string };
			customMetadata?: Record<string, string>;
		},
	): Promise<{ key: string; size?: number } | null>;
	get(
		key: string,
	): Promise<{
		body: ReadableStream<Uint8Array>;
		contentType?: string | null;
		customMetadata?: Record<string, string>;
	} | null>;
	head(key: string): Promise<{ key: string; size?: number } | null>;
	delete(key: string): Promise<void>;
}

interface HyperdriveLike {
	id: string;
	config: { database: string; host: string; port: number; user: string };
	connectionString: string;
}

interface KVNamespaceLike {
	get(key: string, type?: "text"): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/** The slice of the Workers Images binding the share cards use. */
interface ImagesHandleLike {
	transform(options: Record<string, unknown>): ImagesHandleLike;
	draw(
		overlay: ImagesHandleLike | ReadableStream<Uint8Array>,
		options?: { left?: number; top?: number; right?: number; bottom?: number; opacity?: number },
	): ImagesHandleLike;
	output(options: { format: string; quality?: number }): Promise<{
		response(options?: { headers?: HeadersInit }): Response;
	}>;
}

interface ImagesBindingLike {
	input(stream: ReadableStream<Uint8Array>): ImagesHandleLike;
	text(
		content: string,
		options: { font: { url: string }; color?: string; size?: number },
	): ImagesHandleLike;
}

/** wrangler.jsonc bindings plus the plain-text vars and secrets. */
interface Env {
	ASSETS: { fetch: (input: string | URL | Request) => Promise<Response> };
	CACHE: KVNamespaceLike;
	SESSION: KVNamespaceLike;
	MEDIA: R2BucketLike;
	HYPERDRIVE: HyperdriveLike;
	HYPERDRIVE_CACHED: HyperdriveLike;
	IMAGES: ImagesBindingLike;
	/** Workers rate limiter for search (wrangler.jsonc `ratelimits`). */
	SEARCH_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	EMDASH_SITE_URL: string;
	NEON_DATABASE_URL: string;
	NEON_DEV_DATABASE_URL: string;
	EMDASH_ENCRYPTION_KEY: string;
	RESEND_API_KEY: string;
	EMAIL_FROM: string;
	CLAIMS_INBOX: string;
	TURNSTILE_SITE_KEY: string;
	TURNSTILE_SECRET_KEY: string;
	EMDASH_TURNSTILE_SITE_KEY: string;
	EMDASH_TURNSTILE_SECRET_KEY: string;
}

declare module "cloudflare:workers" {
	const env: Env;
	const ctx: {
		waitUntil(promise: Promise<unknown>): void;
		passThroughOnException(): void;
	};
}
