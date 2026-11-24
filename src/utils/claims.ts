import { handleContentCreate, handleMediaCreate, handleMediaDelete } from "emdash";
import { getDb } from "emdash/runtime";
import { z } from "zod";
import { deleteObject, putObject } from "./media-store";
import { sendEmail } from "./email";
import { siteConfig } from "./site";
import { verifyTurnstile } from "./turnstile";

/**
 * The public claim form: validate, verify the human, keep the evidence in R2,
 * save a claims entry, tell the desk.
 *
 * Order matters. Cheap checks come first; the R2 upload happens before the
 * database write so the entry can carry the file it belongs to and one write
 * is enough; the email is last and best effort — a saved claim with a failed
 * notification is still a saved claim, and the desk can see it in the admin.
 */

/** The select options the `claims.platform` field allows. */
const PLATFORMS = [
	"Facebook",
	"X",
	"WhatsApp",
	"Instagram",
	"TikTok",
	"YouTube",
	"Web",
	"Other",
] as const;

type PlatformToken = (typeof PLATFORMS)[number];

/**
 * What the form shows, and the token the field accepts. Radio/TV, in person
 * and "somewhere else" all collapse to Other: the schema's options are fixed,
 * and the claim text carries the detail.
 */
export const PLATFORM_OPTIONS: Array<{ label: string; value: PlatformToken }> = [
	{ label: "WhatsApp", value: "WhatsApp" },
	{ label: "Facebook", value: "Facebook" },
	{ label: "X", value: "X" },
	{ label: "Instagram", value: "Instagram" },
	{ label: "TikTok", value: "TikTok" },
	{ label: "YouTube", value: "YouTube" },
	{ label: "A news website", value: "Web" },
	{ label: "Radio or TV", value: "Other" },
	{ label: "In person", value: "Other" },
	{ label: "Somewhere else", value: "Other" },
];

function platformToken(label: string | undefined): string | undefined {
	if (!label) return undefined;
	return PLATFORM_OPTIONS.find((option) => option.label === label)?.value ?? label;
}

const CLAIM_MIN_CHARS = 20;
const CLAIM_MAX_CHARS = 4000;
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** Only images: the `attachment` field is an image field, and video belongs in `link`. */
const ATTACHMENT_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/**
 * FormData gives strings, or nothing at all. Every optional field is
 * `.nullish()`, so a blank one is null rather than a validation failure, and
 * never the string "undefined".
 */
const claimSchema = z.object({
	claim: z
		.string()
		.trim()
		.min(CLAIM_MIN_CHARS, "Say what the claim is — at least a sentence.")
		.max(CLAIM_MAX_CHARS, "That is longer than we can read. Summarise it, please."),
	platform: z.enum(PLATFORMS, { error: "Tell us where you saw it." }),
	country: z.string().trim().max(80).nullish(),
	link: z
		.string()
		.trim()
		.max(2000)
		.refine((value) => /^https?:\/\/\S+$/i.test(value), "That link does not look right.")
		.nullish(),
	name: z.string().trim().max(160).nullish(),
	email: z
		.string()
		.trim()
		.max(160)
		.refine(
			(value) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value),
			"That email does not look right.",
		)
		.nullish(),
	consent: z.boolean().nullish(),
});

/**
 * A flat result, because templates read it field by field. `kind` says what
 * happened, `errors` maps input names to copy, `values` echoes what the
 * reader typed so the form can be re-rendered.
 */
export interface ClaimSubmitResult {
	ok: boolean;
	kind: "ok" | "invalid" | "spam" | "attachment" | "server";
	/** Copy for the page-level alert (server and attachment failures). */
	message?: string;
	errors?: Record<string, string[]>;
	values?: ClaimFormValues;
	/** The claim saved but the desk email failed: log it, reassure the reader. */
	notifyError?: string;
}

/** What the form sends, before validation: strings, or nothing at all. */
export interface ClaimFormValues {
	claim?: string;
	platform?: string;
	country?: string;
	link?: string;
	name?: string;
	email?: string;
	consent?: boolean;
}

function field(form: FormData, name: string): string | undefined {
	const value = form.get(name);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function checkbox(form: FormData, name: string): boolean | undefined {
	const value = form.get(name);
	if (value === null) return undefined;
	if (typeof value === "string") return value !== "off" && value !== "false";
	return true;
}

function upload(form: FormData, name: string): File | null {
	const value = form.get(name);
	return value instanceof File && value.size > 0 ? value : null;
}

/** A short, safe file stem for the R2 key: ASCII only, 40 characters. */
function safeName(original: string): string {
	const base = (original.split("/").pop() ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return base || "attachment";
}

/** Field errors keyed by input name, with the copy the form shows. */
function toFieldErrors(error: z.ZodError): Record<string, string[]> {
	const errors: Record<string, string[]> = {};
	for (const issue of error.issues) {
		const name = String(issue.path[0] ?? "form");
		(errors[name] ??= []).push(issue.message);
	}
	if (Object.keys(errors).length === 0) {
		errors.form = ["We could not read that submission. Please try again."];
	}
	return errors;
}

interface StoredAttachment {
	/** The media-library row, so the admin thumbnail and picker work. */
	id: string;
	storageKey: string;
	url: string;
	filename: string;
	mimeType: string;
	size: number;
}

/**
 * Puts the screenshot in R2 under `claims/`, then registers it in the media
 * library so editors can open it from the claim. Objects in the bucket are
 * readable through EmDash's media file route, so the key is also the link we
 * put in the desk email; keys are random, so nothing here is guessable.
 */
async function storeAttachment(
	db: Awaited<ReturnType<typeof getDb>>,
	file: File,
): Promise<StoredAttachment | string> {
	const ext = ATTACHMENT_EXT[file.type.toLowerCase()];
	if (!ext) {
		return "Send a JPG, PNG or WebP image up to 8 MB. For video, paste the link instead.";
	}
	if (file.size > ATTACHMENT_MAX_BYTES) {
		return "That file is larger than 8 MB. A smaller screenshot is fine.";
	}

	const now = new Date();
	const bytes = await file.arrayBuffer();
	const storageKey = `claims/${String(now.getFullYear())}${String(now.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}-${safeName(file.name)}.${ext}`;
	const filename = file.name.slice(0, 120);
	const saved = await putObject(
		storageKey,
		new Uint8Array(bytes),
		file.type,
		{ source: "claim-form", filename },
	);
	if (!saved) return "We could not save that file. Please try again.";

	const url = `/_emdash/api/media/file/${storageKey}`;
	const registered = db
		? await handleMediaCreate(db, {
				filename,
				mimeType: file.type,
				size: file.size,
				storageKey,
				alt: "Screenshot supplied with a claim submission",
			})
		: undefined;

	const itemId =
		registered && "data" in registered
			? registered.data.item.id
			: undefined;
	if (!itemId) {
		console.warn("[claims] uploaded but not registered in the media library:", storageKey);
	}

	return {
		// Without a library row the storage key still resolves through the
		// file route, so the claim keeps its evidence either way.
		id: itemId ?? storageKey,
		storageKey,
		url,
		filename,
		mimeType: file.type,
		size: file.size,
	};
}

/** The value the `image` field stores: id + src is what the admin renders. */
function attachmentValue(attachment: StoredAttachment) {
	return {
		id: attachment.id,
		src: attachment.url,
		alt: attachment.filename,
		filename: attachment.filename,
		mimeType: attachment.mimeType,
		meta: {
			storageKey: attachment.storageKey,
			size: attachment.size,
			source: "claim-form",
		},
	};
}

/** Best-effort cleanup when the claim itself could not be saved. */
async function discardAttachment(
	db: Awaited<ReturnType<typeof getDb>>,
	attachment: StoredAttachment,
): Promise<void> {
	try {
		if (db && attachment.id !== attachment.storageKey) {
			await handleMediaDelete(db, attachment.id);
		}
		await deleteObject(attachment.storageKey);
	} catch (error) {
		console.error("[claims] cleanup failed:", error);
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function asText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

function deskEmail(options: {
	values: z.output<typeof claimSchema>;
	attachment: StoredAttachment | null;
	origin: string;
}): { subject: string; html: string; text: string } {
	const { values, attachment, origin } = options;
	const adminUrl = `${origin}/_emdash/admin/content/claims`;
	const rows: Array<[string, string | null]> = [
		["Platform", asText(values.platform)],
		["Country", asText(values.country)],
		["Link", asText(values.link)],
		["Name", asText(values.name)],
		["Email", asText(values.email)],
		["Wants a follow-up", values.consent === false ? "No" : "Yes"],
		[
			"Screenshot",
			attachment ? `${origin}${attachment.url}` : null,
		],
	];
	const filled = rows.filter(([, value]) => value !== null) as Array<[string, string]>;
	const claim = values.claim;

	const text = [
		"A new climate claim came in from the site.",
		"",
		`CLAIM: ${claim}`,
		"",
		...filled.map(([label, value]) => `${label.toUpperCase()}: ${value}`),
		"",
		`Review it: ${adminUrl}`,
	].join("\n");

	const html = [
		'<div style="font:400 15px/24px -apple-system,Segoe UI,Roboto,sans-serif;color:#12261B">',
		'<h2 style="font:700 20px/28px -apple-system,Segoe UI,Roboto,sans-serif;margin:0 0 16px">New claim from the site</h2>',
		`<div style="background:#F2F5F1;padding:16px;border-radius:8px;margin:0 0 18px;white-space:pre-wrap">${escapeHtml(claim)}</div>`,
		'<table style="border-collapse:collapse;font-size:14px;line-height:22px">',
		...filled.map(
			([label, value]) =>
				`<tr><th align="left" style="padding:4px 14px 4px 0;color:#4A6C57;font-weight:700;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</th><td style="padding:4px 0">${
					/^https?:/i.test(value)
						? `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>`
						: escapeHtml(value)
				}</td></tr>`,
		),
		"</table>",
		`<p style="margin:22px 0 0"><a href="${escapeHtml(adminUrl)}">Open the claims list</a></p>`,
		'<p style="font-size:12px;color:#64756B;margin:16px 0 0">Check Climate Africa · automated notification from the claim form</p>',
		"</div>",
	].join("");

	const short = claim.length > 70 ? `${claim.slice(0, 70)}…` : claim;
	return { subject: `New claim: ${short}`, html, text };
}

/**
 * Handles one POST from the claim form. Never throws: every failure is a
 * result the template can show.
 */
export async function submitClaim(options: {
	formData: FormData;
	origin: string;
	remoteIp?: string | null;
}): Promise<ClaimSubmitResult> {
	const { formData, origin, remoteIp } = options;

	// Honeypot: a filled hidden field is a bot. Answer as if it worked.
	if (field(formData, "website")) return { ok: true, kind: "ok" };

	const raw: ClaimFormValues = {
		claim: field(formData, "claim"),
		platform: field(formData, "platform"),
		country: field(formData, "country"),
		link: field(formData, "link"),
		name: field(formData, "name"),
		email: field(formData, "email"),
		consent: checkbox(formData, "consent"),
	};

	// The form sends human labels; the field stores one of eight tokens.
	const parsed = claimSchema.safeParse({
		...raw,
		platform: platformToken(raw.platform),
	});
	if (!parsed.success) {
		return {
			ok: false,
			kind: "invalid",
			errors: toFieldErrors(parsed.error),
			values: raw,
		};
	}

	const human = await verifyTurnstile(field(formData, "cf-turnstile-response"), remoteIp);
	if (!human.ok) {
		console.warn("[claims] turnstile rejected:", human.reason, human.codes.join(","));
		return {
			ok: false,
			kind: "spam",
			message:
				"We could not confirm you are human. Solve the check on the form and send it again.",
			values: raw,
		};
	}

	const db = await getDb();
	if (!db) {
		return {
			ok: false,
			kind: "server",
			message: "We could not reach the database. Please try again shortly.",
			values: raw,
		};
	}

	// The file goes up first so the entry can reference it in one write.
	const file = upload(formData, "attachment");
	let attachment: StoredAttachment | null = null;
	if (file) {
		const stored = await storeAttachment(db, file);
		if (typeof stored === "string") {
			return { ok: false, kind: "attachment", message: stored, values: raw };
		}
		attachment = stored;
	}

	const data = parsed.data;
	const created = await handleContentCreate(db, "claims", {
		data: {
			claim: data.claim,
			platform: data.platform,
			country: data.country ?? null,
			link: data.link ?? null,
			name: data.name ?? null,
			email: data.email ?? null,
			consent: data.consent ?? null,
			review_status: "new",
			notes: `Submitted ${new Date().toISOString()} through the claim form.`,
			attachment: attachment ? attachmentValue(attachment) : null,
		},
		// Claims are never public and never routed; draft keeps them out of
		// every read the site does.
		status: "draft",
	});

	// ApiResult is a tagged union; `in` keeps this readable without narrowing games.
	const saved = "data" in created ? created.data : undefined;
	if (!saved?.item?.id) {
		const reason = "error" in created ? `${created.error.code}: ${created.error.message}` : "no id";
		console.error("[claims] save rejected:", reason);
		if (attachment) await discardAttachment(db, attachment);
		return {
			ok: false,
			kind: "server",
			message: "We could not save your claim just now. Please try again.",
			values: raw,
		};
	}

	const email = deskEmail({ values: data, attachment, origin });
	const sent = await sendEmail({
		to: (await siteConfig()).claimsInbox,
		subject: email.subject,
		html: email.html,
		text: email.text,
		...(data.email ? { replyTo: data.email } : {}),
	});

	// The claim is saved; a failed email is a log line, not a rejection.
	if (!sent.ok) {
		return { ok: true, kind: "ok", notifyError: sent.error };
	}
	return { ok: true, kind: "ok" };
}
