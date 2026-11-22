/**
 * Site settings plugin (native).
 *
 * The handful of things the desk should be able to change without a deploy:
 * where readers write, where claim submissions are emailed, the social
 * profiles in the header and footer, and the city behind the weather line.
 *
 * Values are stored in EmDash's options table under
 * `plugin:checkclimate-site-settings:settings:<key>` and get an editable form
 * in the admin, under this plugin's card. Schema defaults only prefill that
 * form — EmDash never writes them to the store — so the site reads through
 * `src/utils/site.ts`, which merges stored values over the same defaults and
 * treats an empty value as "use the default".
 *
 * This plugin has no hooks and no routes: it is a settings form and an
 * identity. Reading is done by the site, not by plugin code, so a page pays
 * one options-table lookup (cached for a minute per isolate), not a plugin
 * runtime.
 */
import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

export const SITE_SETTINGS_ID = "checkclimate-site-settings";

/** Keys this plugin owns. Mirrored by `src/utils/site.ts`. */
export const SETTING_KEYS = {
	contactEmail: "contactEmail",
	claimsInbox: "claimsInbox",
	facebookUrl: "facebookUrl",
	xUrl: "xUrl",
	instagramUrl: "instagramUrl",
	youtubeUrl: "youtubeUrl",
	whatsappUrl: "whatsappUrl",
	weatherCity: "weatherCity",
	weatherCountry: "weatherCountry",
	weatherLatitude: "weatherLatitude",
	weatherLongitude: "weatherLongitude",
} as const;

export function siteSettingsPlugin(): PluginDescriptor {
	return {
		id: SITE_SETTINGS_ID,
		displayName: "Site settings",
		description:
			"Contact address, claim inbox, social profiles and the weather city. Editable in the admin.",
		version: "1.0.0",
		format: "native",
		entrypoint: "@checkclimate/plugin-site-settings",
	};
}

export function createPlugin() {
	return definePlugin({
		id: SITE_SETTINGS_ID,
		version: "1.0.0",
		admin: {
			settingsSchema: {
				contactEmail: {
					type: "email",
					label: "Contact email",
					description:
						"Shown in the footer and on the correction link under every story.",
					default: "CheckClimateAfrica@gmail.com",
				},
				claimsInbox: {
					type: "email",
					label: "Claim submissions inbox",
					description:
						"Where the fact-check desk is emailed when a reader submits a claim.",
					default: "CheckClimateAfrica@gmail.com",
				},
				facebookUrl: {
					type: "url",
					label: "Facebook",
					description: "Leave empty to hide the link.",
				},
				xUrl: {
					type: "url",
					label: "X / Twitter",
					description: "Leave empty to hide the link.",
				},
				instagramUrl: {
					type: "url",
					label: "Instagram",
					description: "Leave empty to hide the link.",
				},
				youtubeUrl: {
					type: "url",
					label: "YouTube",
					description: "Leave empty to hide the link.",
				},
				whatsappUrl: {
					type: "url",
					label: "WhatsApp channel",
					description: "Leave empty to hide the link.",
				},
				weatherCity: {
					type: "string",
					label: "Weather city",
					description: "The place named in the top bar.",
					default: "Ilorin",
				},
				weatherCountry: {
					type: "string",
					label: "Weather city country code",
					default: "NG",
				},
				weatherLatitude: {
					type: "number",
					label: "Weather latitude",
					description: "Decimal degrees, e.g. 8.4966",
					min: -90,
					max: 90,
					default: 8.4966,
				},
				weatherLongitude: {
					type: "number",
					label: "Weather longitude",
					description: "Decimal degrees, e.g. 4.5426",
					min: -180,
					max: 180,
					default: 4.5426,
				},
			},
		},
	});
}

export default createPlugin;
