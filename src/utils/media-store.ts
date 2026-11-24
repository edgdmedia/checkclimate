/**
 * Direct object access to the media bucket, for the two places the EmDash
 * media library does not cover:
 *
 *   - `src/utils/claims.ts` uploads the evidence file before any library row
 *     exists, and deletes it again if the claim fails to save;
 *   - `src/pages/share/[format]/[slug].png.ts` keeps a cache of rendered
 *     share cards under `share/…`.
 *
 * Everything else goes through EmDash's own storage adapter. This module is
 * configured by exactly the same `S3_*` variables the `s3()` adapter reads, so
 * it always points at the same bucket (`checkclimate-media`) and the same keys
 * — which is what makes the `/​_emdash/api/media/file/<key>` URLs these calls
 * produce resolve.
 *
 * When `S3_BUCKET` or the credentials are missing (laptop, CI) every function
 * says "no": callers already treat a failed upload as a user-facing "could not
 * save", and dev writes media to local disk instead.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const BUCKET = (): string => (process.env.S3_BUCKET ?? "").trim();
const configured = (): boolean =>
	BUCKET() !== "" && !!process.env.S3_ACCESS_KEY_ID && !!process.env.S3_SECRET_ACCESS_KEY;

let client: S3Client | undefined;
function s3(): S3Client {
	return (client ??= new S3Client({
		region: process.env.S3_REGION?.trim() || "auto",
		endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
		},
	}));
}

/** The object's bytes, or null when it is not there (or nothing is configured). */
export async function getObject(
	key: string,
): Promise<{ body: Buffer; contentType?: string } | null> {
	if (!configured()) return null;
	try {
		const result = await s3().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
		if (!result.Body) return null;
		const bytes = await result.Body.transformToByteArray();
		return { body: Buffer.from(bytes), contentType: result.ContentType };
	} catch (error) {
		const name = (error as { name?: string })?.name;
		if (name === "NoSuchKey" || name === "NotFound") return null;
		throw error;
	}
}

/** True when the object was written. */
export async function putObject(
	key: string,
	body: Buffer | Uint8Array | ReadableStream<Uint8Array>,
	contentType: string,
	customMetadata?: Record<string, string>,
): Promise<boolean> {
	if (!configured()) return false;
	await s3().send(
		new PutObjectCommand({
			Bucket: BUCKET(),
			Key: key,
			Body: body instanceof ReadableStream ? (body as unknown as Uint8Array) : body,
			ContentType: contentType,
			// R2 keeps `x-amz-meta-` headers, which is where the claim form's
			// source and filename used to live as R2 custom metadata.
			Metadata: customMetadata,
		}),
	);
	return true;
}

export async function deleteObject(key: string): Promise<void> {
	if (!configured()) return;
	await s3().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
}
