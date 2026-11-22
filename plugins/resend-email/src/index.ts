/**
 * Resend email transport (native plugin).
 *
 * EmDash sends its own mail — magic links, invite emails, comment
 * notifications — through the exclusive `email:deliver` hook. Without a
 * provider those sends are dropped, so this plugin is what makes admin sign-in
 * work on the Worker.
 *
 * The key and the From: address come from Worker vars/secrets, not from the
 * settings form: they are operator credentials, and `EMDASH_ENCRYPTION_KEY`
 * rotation should not be able to strand them.
 *
 * The desk's own claim notification (`src/utils/email.ts`) posts to the same
 * API directly, because the form needs to know right away whether the send
 * worked and must still succeed when it did not.
 */
import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";
import { resendApiKey, resendFrom } from "./env.mjs";
import { sendWithResend } from "./transport.ts";

export const RESEND_EMAIL_ID = "resend-email";
export const RESEND_EMAIL_VERSION = "1.0.0";

export function resendEmailPlugin(): PluginDescriptor {
	return {
		id: RESEND_EMAIL_ID,
		displayName: "Resend email",
		description: "Sends EmDash's transactional mail through Resend.",
		version: RESEND_EMAIL_VERSION,
		format: "native",
		entrypoint: "@checkclimate/plugin-resend-email",
		capabilities: ["hooks.email-transport:register"],
	};
}

export function createPlugin() {
	return definePlugin({
		id: RESEND_EMAIL_ID,
		version: RESEND_EMAIL_VERSION,
		capabilities: ["hooks.email-transport:register"],
		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					const result = await sendWithResend(event.message, {
						apiKey: resendApiKey(),
						from: resendFrom(),
					});

					if (result.ok) {
						ctx.log.info("Sent via Resend", {
							to: event.message.to,
							subject: event.message.subject,
							source: event.source,
							id: result.id,
						});
						return;
					}

					// Throwing is honest: the caller asked for the mail to be delivered
					// and it was not. EmDash logs the hook failure and keeps going.
					throw new Error(`Resend did not accept the message: ${result.error}`);
				},
			},
		},
	});
}

export default createPlugin;
