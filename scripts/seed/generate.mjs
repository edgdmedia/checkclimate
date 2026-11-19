/**
 * Build seed/seed.json for Check Climate Africa.
 *
 * The copy lives in stories.mjs (full stories) and news.mjs (briefs) so it is
 * easy to edit. Run `node scripts/seed/generate.mjs` after changing either.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { briefs } from "./news.mjs";
import { stories } from "./stories.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let counter = 0;
const nextKey = () => `k${++counter}`;

const span = (text) => ({ _type: "span", text, _key: nextKey() });

const block = (style, text) => ({
	_type: "block",
	style,
	children: [span(text)],
	_key: nextKey(),
});

/** Turn the line-based story bodies into Portable Text blocks. */
function bodyToBlocks(lines) {
	return lines.map((line) => {
		if (line.startsWith("## ")) return block("h2", line.slice(3));
		if (line.startsWith("> -- ")) return block("blockquote", line.slice(2));
		if (line.startsWith("> ")) return block("blockquote", line.slice(2));
		if (line.startsWith("- ")) {
			return {
				_type: "block",
				style: "normal",
				listItem: "bullet",
				level: 1,
				children: [span(line.slice(2))],
				_key: nextKey(),
			};
		}
		return block("normal", line);
	});
}

const categoryTerms = [
	["news", "News"],
	["fact-check", "Fact Check"],
	["agriculture", "Agriculture"],
	["environment", "Environment"],
	["green-energy", "Green Energy"],
	["sustainability", "Sustainability"],
	["aviation", "Aviation"],
	["energy", "Energy"],
	["climate-action", "Climate Action"],
	["africa", "Africa"],
	["climate-resilience", "Climate Resilience"],
];

const titleCase = (slug) =>
	slug
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");

const posts = [...stories, ...briefs].map((story) => {
	const data = {
		title: story.title,
		excerpt: story.excerpt,
		kicker: story.kicker ?? "none",
		content: bodyToBlocks(story.body),
	};

	if (story.glance?.length) data.at_a_glance = story.glance;
	if (story.kicker === "fact_check") {
		data.claim = story.claim;
		data.claim_source = story.claimSource;
		data.verdict = story.verdict;
		data.verdict_summary = story.verdictSummary;
		data.verdict_note = story.verdictNote;
		data.sources = story.sources ?? [];
	}

	return {
		id: `post-${story.slug}`,
		slug: story.slug,
		status: "published",
		data,
		bylines: [{ byline: story.byline }],
		taxonomies: {
			category: [story.category],
			tag: story.tags,
		},
	};
});

const usedTags = [...new Set([...stories, ...briefs].flatMap((s) => s.tags))].sort();

const pages = [
	{
		id: "page-about-us",
		slug: "about-us",
		status: "published",
		data: {
			title: "About us",
			content: [
				block(
					"normal",
					"Check Climate Africa is a pioneering media consultancy initiative focused on disseminating critical climate information to key stakeholders across Africa, including governments, policymakers, and the general public.",
				),
				block(
					"normal",
					"We report on the climate crisis, resilience and adaptation, green energy, agriculture, sustainability and aviation — and we check the claims that shape those debates.",
				),
				block("h2", "Why it matters"),
				block(
					"normal",
					"By providing timely, accurate, and actionable climate insights, Check Climate Africa strives to inform policy decisions, foster public awareness and promote climate resilience.",
				),
				block("h2", "How we work"),
				block(
					"normal",
					"Our reporting is independent. Fact checks are reviewed by an editor before publication, cite the evidence we relied on, and are corrected in public when we get something wrong.",
				),
				block(
					"normal",
					"Send questions, corrections or story tips to CheckClimateAfrica@gmail.com. To ask us to check a claim, use the Submit a claim form.",
				),
			],
		},
	},
	{
		id: "page-contact-us",
		slug: "contact-us",
		status: "published",
		data: {
			title: "Contact us",
			content: [
				block(
					"normal",
					"Everything goes to one inbox: CheckClimateAfrica@gmail.com. Pick a subject line so it reaches the right person faster.",
				),
				block("h2", "Questions"),
				block("normal", "About a story, our work or our sources."),
				block("h2", "Concerns and corrections"),
				block("normal", "Spotted an error? Tell our editors. Include the URL and what is wrong."),
				block("h2", "Adverts and partnerships"),
				block("normal", "Reach readers who follow African climate news."),
				block("h2", "Submit a claim"),
				block(
					"normal",
					"Use the Submit a claim form to send a post, video, image or quote you want checked.",
				),
			],
		},
	},
	{
		id: "page-privacy-policy",
		slug: "privacy-policy-2",
		status: "published",
		data: {
			title: "Privacy policy",
			content: [
				block(
					"normal",
					"Check Climate Africa collects the minimum information needed to publish the site and respond to readers.",
				),
				block("h2", "What we collect"),
				block("normal", "Server logs, anonymous analytics, and anything you send us through a form or email."),
				block("normal", "If you submit a claim, we store the claim, the link or file you send, and your contact details so we can reply."),
				block("h2", "How long we keep it"),
				block("normal", "Claim submissions are kept while we investigate and for our records afterwards. Email is kept for as long as it is needed to answer you."),
				block("h2", "Your choices"),
				block("normal", "Write to CheckClimateAfrica@gmail.com to ask for a copy of what we hold about you, or to ask us to delete it."),
			],
		},
	},
	{
		id: "page-accessibility",
		slug: "accessibility-statement",
		status: "published",
		data: {
			title: "Accessibility statement",
			content: [
				block(
					"normal",
					"Check Climate Africa aims to meet WCAG 2.2 AA. Pages are built with real headings, landmarks, visible focus states and text that meets 4.5:1 contrast.",
				),
				block("h2", "What we test"),
				block("normal", "Keyboard navigation, screen reader order, colour contrast in light and dark mode, and layouts at 360px without horizontal scrolling."),
				block("h2", "Tell us about a barrier"),
				block("normal", "If something is hard to use, email CheckClimateAfrica@gmail.com with the page and what happened. We will fix it or offer the information another way."),
			],
		},
	},
];

const seed = {
	$schema: "https://emdashcms.com/seed.schema.json",
	version: "1",
	meta: {
		name: "Check Climate Africa",
		description: "Climate news and fact checks for Africa",
		author: "Check Climate Africa",
	},
	settings: {
		title: "Check Climate Africa",
		tagline: "Disseminating Critical Climate Information",
	},
	collections: [
		{
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			urlPattern: "/{year}/{month}/{day}/{slug}",
			supports: ["drafts", "revisions", "preview", "scheduling", "search", "seo"],
			commentsEnabled: true,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "excerpt", label: "Excerpt", type: "text" },
				{ slug: "content", label: "Content", type: "portableText", searchable: true },
				{ slug: "featured_image", label: "Featured image", type: "image" },
				{
					slug: "kicker",
					label: "Kicker",
					type: "select",
					defaultValue: "none",
					validation: { options: ["none", "alert", "fact_check"] },
				},
				{ slug: "at_a_glance", label: "At a glance", type: "json" },
				{ slug: "claim", label: "Claim", type: "text" },
				{ slug: "claim_source", label: "Claim source", type: "string" },
				{
					slug: "verdict",
					label: "Verdict",
					type: "select",
					validation: {
						options: ["False", "Misleading", "False context", "Partly true", "True", "Unproven"],
					},
				},
				{ slug: "verdict_summary", label: "Verdict summary", type: "text" },
				{ slug: "verdict_note", label: "Verdict note", type: "text" },
				{ slug: "sources", label: "Sources", type: "json" },
			],
		},
		{
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			urlPattern: "/{slug}",
			supports: ["drafts", "revisions", "preview", "search", "seo"],
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "content", label: "Content", type: "portableText", searchable: true },
				{ slug: "featured_image", label: "Featured image", type: "image" },
			],
		},
		{
			slug: "claims",
			label: "Claims",
			labelSingular: "Claim",
			description: "Reader claim submissions. Never rendered publicly.",
			routable: false,
			supports: ["drafts"],
			fields: [
				{ slug: "claim", label: "Claim", type: "text", required: true, searchable: true },
				{
					slug: "platform",
					label: "Platform",
					type: "select",
					validation: { options: ["Facebook", "X", "WhatsApp", "Instagram", "TikTok", "YouTube", "Web", "Other"] },
				},
				{ slug: "country", label: "Country", type: "string" },
				{ slug: "link", label: "Link", type: "url" },
				{ slug: "attachment", label: "Attachment", type: "image" },
				{ slug: "name", label: "Name", type: "string" },
				{ slug: "email", label: "Email", type: "string" },
				{ slug: "consent", label: "Consent to contact", type: "boolean" },
				{
					slug: "review_status",
					label: "Status",
					type: "select",
					defaultValue: "new",
					validation: { options: ["new", "checking", "published", "rejected"] },
				},
				{ slug: "notes", label: "Notes", type: "text" },
			],
		},
	],
	taxonomies: [
		{
			name: "category",
			label: "Categories",
			labelSingular: "Category",
			hierarchical: true,
			collections: ["posts"],
			terms: categoryTerms.map(([slug, label]) => ({ slug, label })),
		},
		{
			name: "tag",
			label: "Tags",
			labelSingular: "Tag",
			hierarchical: false,
			collections: ["posts"],
			terms: usedTags.map((slug) => ({ slug, label: titleCase(slug) })),
		},
	],
	bylines: [
		{
			id: "byline-check-climate",
			slug: "check-climate-desk",
			displayName: "Check Climate Africa Desk",
			bio: "Reporting and fact checking from the Check Climate Africa newsroom.",
		},
		{
			id: "byline-lanre",
			slug: "lanre-adebayo",
			displayName: "Lanre Adebayo",
			bio: "Senior reporter covering climate, energy and the environment across West Africa.",
		},
	],
	menus: [
		{
			name: "primary",
			label: "Primary navigation",
			items: [
				{ type: "custom", label: "Home", url: "/" },
				{ type: "custom", label: "Fact Check", url: "/category/fact-check/" },
				{ type: "custom", label: "News", url: "/category/news/" },
				{ type: "custom", label: "Agriculture", url: "/category/agriculture/" },
				{ type: "custom", label: "Environment", url: "/category/environment/" },
				{ type: "custom", label: "Green Energy", url: "/category/green-energy/" },
				{ type: "custom", label: "Sustainability", url: "/category/sustainability/" },
				{ type: "custom", label: "Aviation", url: "/category/aviation/" },
			],
		},
		{
			name: "footer",
			label: "Footer navigation",
			items: [
				{ type: "custom", label: "About Us", url: "/about-us/" },
				{ type: "custom", label: "Contact Us", url: "/contact-us/" },
				{ type: "custom", label: "Privacy Policy", url: "/privacy-policy-2/" },
				{ type: "custom", label: "Accessibility", url: "/accessibility-statement/" },
				{ type: "custom", label: "Submit a claim", url: "/submit-a-claim/" },
			],
		},
	],
	content: {
		posts,
		pages,
		claims: [
			{
				id: "claim-sample",
				slug: "sample-claim",
				status: "draft",
				data: {
					claim: "A video shows snow falling in Kano in July.",
					platform: "WhatsApp",
					country: "Nigeria",
					link: "https://example.com/claim",
					name: "Sample reader",
					email: "reader@example.com",
					consent: true,
					review_status: "new",
					notes: "Sample row created by the seed. Safe to delete.",
				},
			},
		],
	},
};

const dates = Object.fromEntries(
	[...stories, ...briefs].map((story) => [story.slug, story.date]),
);

await mkdir(resolve(root, "data"), { recursive: true });
await writeFile(resolve(root, "seed/seed.json"), `${JSON.stringify(seed, null, "\t")}\n`, "utf8");
await writeFile(resolve(root, "seed/dates.json"), `${JSON.stringify(dates, null, "\t")}\n`, "utf8");
console.log(`seed.json written: ${posts.length} posts, ${pages.length} pages, ${usedTags.length} tags`);