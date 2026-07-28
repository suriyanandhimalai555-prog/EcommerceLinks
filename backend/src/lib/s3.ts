import { randomUUID } from "node:crypto";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CFG } from "../config.js";

export const IMAGE_CONTENT_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
] as const;

export const DOCUMENT_CONTENT_TYPES = ["application/pdf"] as const;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"application/pdf": "pdf",
};

export function s3Configured(): boolean {
	return Boolean(
		CFG.AWS_BUCKET_NAME && CFG.AWS_ACCESS_KEY_ID && CFG.AWS_SECRET_ACCESS_KEY,
	);
}

let client: S3Client | null = null;

export function s3Client(): S3Client {
	if (!client) {
		client = new S3Client({
			region: CFG.AWS_REGION,
			credentials: {
				accessKeyId: CFG.AWS_ACCESS_KEY_ID,
				secretAccessKey: CFG.AWS_SECRET_ACCESS_KEY,
			},
		});
	}
	return client;
}

export function publicUrl(key: string): string {
	return `${CFG.S3_PUBLIC_BASE_URL}/${key}`;
}

/**
 * Object keys are always `{prefix}/{uuid}.{ext}` with the extension derived
 * from the validated content type — the client's file name never reaches S3.
 */
export function buildKey(prefix: string, contentType: string): string {
	const ext = EXT_BY_CONTENT_TYPE[contentType];
	if (!ext) {
		const e = new Error(`Unsupported content type: ${contentType}`) as Error & {
			statusCode: number;
		};
		e.statusCode = 400;
		throw e;
	}
	return `${prefix}/${randomUUID()}.${ext}`;
}

export const PRODUCT_KEY_RE =
	/^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export const PRODUCT_DOC_KEY_RE =
	/^product-docs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

export function kycKeyRe(memberId: string): RegExp {
	return new RegExp(
		`^kyc/${memberId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`,
	);
}

export function paymentProofKeyRe(memberId: string): RegExp {
	return new RegExp(
		`^payment-proofs-img/${memberId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`,
	);
}

export async function presignUpload(
	key: string,
	contentType: string,
	maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<{ key: string; url: string; fields: Record<string, string> }> {
	const { url, fields } = await createPresignedPost(s3Client(), {
		Bucket: CFG.AWS_BUCKET_NAME,
		Key: key,
		Conditions: [
			["content-length-range", 1, maxBytes],
			["eq", "$Content-Type", contentType],
			["eq", "$key", key],
		],
		Fields: { "Content-Type": contentType },
		Expires: 300,
	});
	return { key, url, fields };
}

/**
 * Presigned GET URL. When `downloadName` is given (used for PDFs) the response
 * carries `Content-Disposition: inline; filename="…"` so browsers render the
 * file inline but keep the real filename if the user downloads it.
 */
export async function presignGet(
	key: string,
	expiresSec = 900,
	downloadName?: string,
): Promise<string> {
	return getSignedUrl(
		s3Client(),
		new GetObjectCommand({
			Bucket: CFG.AWS_BUCKET_NAME,
			Key: key,
			...(downloadName
				? { ResponseContentDisposition: contentDisposition(downloadName) }
				: {}),
		}),
		{ expiresIn: expiresSec },
	);
}

/**
 * RFC 6266 Content-Disposition with both an ASCII `filename` fallback and an
 * RFC 5987 `filename*` (UTF-8) so non-ASCII names (e.g. Tamil) survive download
 * without emitting a malformed header value.
 */
export function contentDisposition(name: string): string {
	const safe = sanitizeDownloadName(name);
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
	const encoded = encodeURIComponent(safe).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Strip characters that would break the Content-Disposition header or allow
 * header injection (quotes, backslashes, control chars, path separators), and
 * cap the length. Falls back to a generic name if nothing usable remains.
 */
export function sanitizeDownloadName(name: string): string {
	const cleaned = Array.from(name)
		// Drop path separators, quotes, and any control chars (code < 0x20) that
		// would break the Content-Disposition header or allow header injection.
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code >= 0x20 && ch !== "\\" && ch !== "/" && ch !== '"';
		})
		.join("")
		.trim()
		.slice(0, 200);
	return cleaned || "document.pdf";
}

export async function objectExists(key: string): Promise<boolean> {
	try {
		await s3Client().send(
			new HeadObjectCommand({ Bucket: CFG.AWS_BUCKET_NAME, Key: key }),
		);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort delete — S3 cannot join the DB transaction, so callers run this after commit. */
export async function deleteObject(key: string): Promise<void> {
	try {
		await s3Client().send(
			new DeleteObjectCommand({ Bucket: CFG.AWS_BUCKET_NAME, Key: key }),
		);
	} catch (err) {
		console.error(`[s3] failed to delete ${key}:`, err);
	}
}
