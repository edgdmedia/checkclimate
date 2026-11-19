/**
 * EmDash's seed applies `publishedAt = now()` to every published entry, which
 * would put every sample story on today's date and break the WordPress-style
 * /yyyy/mm/dd/slug/ URLs. After seeding, copy the intended dates from
 * seed/dates.json into SQLite.
 */
import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = process.env.DATABASE_PATH || "./data/checkclimate.db";
const databaseUrl = databasePath.startsWith("file:") ? databasePath : `file:${databasePath}`;
const dates = JSON.parse(await readFile(resolve(root, "seed/dates.json"), "utf8"));

const client = createClient({ url: databaseUrl.startsWith("file:") ? databaseUrl : `file:${resolve(root, databaseUrl)}` });

let updated = 0;
for (const [slug, date] of Object.entries(dates)) {
	const result = await client.execute({
		sql: "UPDATE ec_posts SET published_at = ? WHERE slug = ?",
		args: [new Date(date).toISOString(), slug],
	});
	updated += result.rowsAffected;
}

await client.close();
console.log(`published dates set for ${updated}/${Object.keys(dates).length} posts`);