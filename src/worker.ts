/**
 * Worker entry point.
 *
 * `handler` is the Astro (Cloudflare adapter) fetch handler. EmDash's
 * `createScheduledHandler()` runs scheduled publishing and maintenance from the
 * every-15-minutes Cron Trigger in wrangler.jsonc. `PluginBridge` is the entry
 * point sandboxed plugins use; exporting it is harmless when none are installed.
 *
 * `emdash doctor` recognises this exact form.
 */
import handler, {
	createScheduledHandler,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
};