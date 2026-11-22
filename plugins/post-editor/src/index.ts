/**
 * Post editor plugin (native, admin-only).
 *
 * Tidies the post edit screen. EmDash 1.5 has no "show this field when"
 * rule, so the fields are given custom editors from ./admin.tsx:
 *
 *   - `kicker` (labelled "Post type") — News / Fact check / Opinion as radio
 *     buttons. It tells the other editors which type is selected.
 *   - the seven fact-check fields — each renders only while the post type is
 *     Fact check, under one "Fact check details" heading.
 *
 * The widgets are attached to the fields in the schema (`widget:
 * "checkclimate-post-editor:<name>"`, see seed/seed.json and
 * scripts/post-types.ts). No hooks, no routes, no storage.
 */
import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

export const POST_EDITOR_ID = "checkclimate-post-editor";
export const POST_EDITOR_VERSION = "1.0.0";

/** Widget names, as `checkclimate-post-editor:<name>` on a field. */
export const POST_EDITOR_WIDGETS = [
	{ name: "post-type", label: "Post type", fieldTypes: ["select"] },
	{ name: "fc-heading-text", label: "Fact check: first field, with heading", fieldTypes: ["text", "string"] },
	{ name: "fc-text", label: "Fact check: one line", fieldTypes: ["string", "text"] },
	{ name: "fc-textarea", label: "Fact check: paragraph", fieldTypes: ["text", "string"] },
	{ name: "fc-verdict", label: "Fact check: verdict", fieldTypes: ["select"] },
	{ name: "fc-list", label: "Fact check: list of points", fieldTypes: ["json"] },
	{ name: "fc-sources", label: "Fact check: sources", fieldTypes: ["json"] },
] as const;

export function postEditorPlugin(): PluginDescriptor {
	return {
		id: POST_EDITOR_ID,
		displayName: "Post editor",
		description: "Post type picker and fact-check fields that only show on fact checks.",
		version: POST_EDITOR_VERSION,
		format: "native",
		entrypoint: "@checkclimate/plugin-post-editor",
		adminEntry: "@checkclimate/plugin-post-editor/admin",
	};
}

export function createPlugin() {
	return definePlugin({
		id: POST_EDITOR_ID,
		version: POST_EDITOR_VERSION,
		admin: {
			entry: "@checkclimate/plugin-post-editor/admin",
			fieldWidgets: POST_EDITOR_WIDGETS.map((widget) => ({
				name: widget.name,
				label: widget.label,
				fieldTypes: [...widget.fieldTypes],
			})),
		},
	});
}

export default createPlugin;
