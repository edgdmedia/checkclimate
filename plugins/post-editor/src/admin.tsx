/**
 * Admin field editors for posts (see ./index.ts).
 *
 * A field widget only receives its own value, so the post-type picker
 * publishes the selected type to a tiny module-level store and the
 * fact-check editors subscribe to it. Both live in this one module, so they
 * share the store; one post editor is open at a time.
 */
import { Button, Input, InputArea, Radio, Select } from "@cloudflare/kumo";
import { useEffect, useId, useSyncExternalStore } from "react";

// ---------------------------------------------------------------- store --

const DEFAULT_TYPE = "news";
let currentType = DEFAULT_TYPE;
const listeners = new Set<() => void>();

function publishType(type: string): void {
	if (type === currentType) return;
	currentType = type;
	for (const listener of listeners) listener();
}

function usePostType(): string {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => currentType,
		() => currentType,
	);
}

// ---------------------------------------------------------------- props --

interface FieldProps {
	value: unknown;
	onChange: (value: unknown) => void;
	label: string;
	id: string;
	required?: boolean;
	options?: unknown;
	validation?: { options?: string[] } | null;
	minimal?: boolean;
}

const TYPE_LABELS: Record<string, { label: string; hint: string }> = {
	news: { label: "News", hint: "A report, story or explainer." },
	fact_check: { label: "Fact check", hint: "Checks a claim and gives a verdict." },
	opinion: { label: "Opinion", hint: "A signed column or commentary." },
};

function optionsOf(props: FieldProps, fallback: string[]): string[] {
	const list = props.validation?.options;
	return Array.isArray(list) && list.length > 0 ? list : fallback;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

// ------------------------------------------------------------ post type --

function PostTypeField(props: FieldProps) {
	const value = asString(props.value) || DEFAULT_TYPE;
	const types = optionsOf(props, ["news", "fact_check", "opinion"]);

	// Tell the fact-check editors which type this post is.
	useEffect(() => {
		publishType(value);
	}, [value]);

	return (
		<Radio.Group
			legend={props.label}
			value={value}
			onValueChange={(next: unknown) => props.onChange(String(next))}
		>
			{types.map((type) => (
				<Radio.Item
					key={type}
					value={type}
					label={TYPE_LABELS[type]?.label ?? type}
					description={TYPE_LABELS[type]?.hint}
				/>
			))}
		</Radio.Group>
	);
}

// ------------------------------------------------------ fact-check only --

/** Renders its children only while the post type is Fact check. */
function FactCheckOnly({ children }: { children: React.ReactNode }) {
	return usePostType() === "fact_check" ? <>{children}</> : null;
}

/** The claim editor carries the section heading (it is the first fact-check field). */
function FactCheckHeading() {
	return (
		<div className="mt-4 border-t pt-6">
			<p className="text-base font-semibold">Fact check details</p>
			<p className="text-sm text-kumo-subtle">
				Shown on fact checks only: the claim, the verdict box and the sources list.
			</p>
		</div>
	);
}

function FactCheckTextField(props: FieldProps & { heading?: boolean }) {
	return (
		<FactCheckOnly>
			{props.heading && <FactCheckHeading />}
			<Input
				id={props.id}
				label={props.label}
				value={asString(props.value)}
				onChange={(event: React.ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
			/>
		</FactCheckOnly>
	);
}

function FactCheckTextAreaField(props: FieldProps & { heading?: boolean }) {
	return (
		<FactCheckOnly>
			{props.heading && <FactCheckHeading />}
			<InputArea
				id={props.id}
				label={props.label}
				value={asString(props.value)}
				autoResize
				onValueChange={(next: string) => props.onChange(next)}
			/>
		</FactCheckOnly>
	);
}

function FactCheckVerdictField(props: FieldProps) {
	const verdicts = optionsOf(props, []);
	return (
		<FactCheckOnly>
			<Select
				label={props.label}
				value={asString(props.value)}
				onValueChange={(next: unknown) => props.onChange(next ? String(next) : null)}
				items={{ "": "Choose a verdict", ...Object.fromEntries(verdicts.map((v) => [v, v])) }}
			/>
		</FactCheckOnly>
	);
}

/** "At a glance": a JSON array of strings, edited one point per line. */
function FactCheckListField(props: FieldProps) {
	const items = Array.isArray(props.value)
		? props.value.map((item) =>
				typeof item === "string" ? item : String((item as { text?: unknown })?.text ?? ""),
			)
		: [];
	return (
		<FactCheckOnly>
			<InputArea
				id={props.id}
				label={props.label}
				description="One short point per line."
				value={items.join("\n")}
				autoResize
				onValueChange={(next: string) => {
					const lines = next.split("\n").map((line) => line.trimEnd());
					// Keep a trailing empty line while typing; drop empties on save shape.
					const cleaned = lines.filter((line, index) => line !== "" || index === lines.length - 1);
					props.onChange(cleaned.some(Boolean) ? cleaned : null);
				}}
			/>
		</FactCheckOnly>
	);
}

interface Source {
	text: string;
	url: string;
}

/** Sources: a JSON array of { text, url } rows. */
function FactCheckSourcesField(props: FieldProps) {
	const baseId = useId();
	const rows: Source[] = Array.isArray(props.value)
		? props.value.map((item) =>
				typeof item === "string"
					? { text: item, url: "" }
					: {
							text: String((item as Partial<Source>)?.text ?? ""),
							url: String((item as Partial<Source>)?.url ?? ""),
						},
			)
		: [];

	const save = (next: Source[]) =>
		props.onChange(next.length > 0 ? next.map((row) => (row.url ? row : { text: row.text })) : null);
	const update = (index: number, patch: Partial<Source>) =>
		save(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

	return (
		<FactCheckOnly>
			<fieldset className="grid gap-3">
				<legend className="mb-2 text-base font-medium">{props.label}</legend>
				{rows.map((row, index) => (
					<div key={`${baseId}-${index}`} className="grid gap-2 rounded-lg border p-3">
						<Input
							label={`Source ${index + 1}`}
							placeholder="What it is, e.g. IPCC AR6 Synthesis Report"
							value={row.text}
							onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
								update(index, { text: event.target.value })
							}
						/>
						<Input
							label="Link (optional)"
							type="url"
							placeholder="https://"
							value={row.url}
							onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
								update(index, { url: event.target.value })
							}
						/>
						<div>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => save(rows.filter((_, i) => i !== index))}
							>
								Remove source
							</Button>
						</div>
					</div>
				))}
				<div>
					<Button size="sm" variant="secondary" onClick={() => save([...rows, { text: "", url: "" }])}>
						Add source
					</Button>
				</div>
			</fieldset>
		</FactCheckOnly>
	);
}

// --------------------------------------------------------------- export --

export const fields = {
	"post-type": PostTypeField,
	"fc-text": FactCheckTextField,
	"fc-heading-text": (props: FieldProps) => <FactCheckTextAreaField {...props} heading />,
	"fc-textarea": FactCheckTextAreaField,
	"fc-verdict": FactCheckVerdictField,
	"fc-list": FactCheckListField,
	"fc-sources": FactCheckSourcesField,
};
