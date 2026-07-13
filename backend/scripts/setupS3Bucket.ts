/**
 * One-time S3 bucket setup for the upload feature (safe to re-run):
 *   1. CORS — allows the browser's presigned-POST uploads from the dev/prod origins
 *   2. Bucket policy — public read for products/* ONLY (kyc/* stays private)
 *
 * Requires the .env AWS credentials to carry s3:PutBucketCORS / s3:PutBucketPolicy.
 * If they don't (recommended: the runtime key should NOT have these), apply the
 * same JSON in the AWS console instead.
 */
import {
	GetBucketCorsCommand,
	GetBucketPolicyCommand,
	PutBucketCorsCommand,
	PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { CFG } from "../src/config.js";
import { s3Client } from "../src/lib/s3.js";
import "dotenv/config";

const ORIGINS = [
	"http://localhost:5173",
	"http://localhost:5174",
	"http://localhost:5175",
	"https://agilavetriglobal.com",
];

async function main() {
	const bucket = CFG.AWS_BUCKET_NAME;
	if (!bucket) throw new Error("AWS_BUCKET_NAME is not set");

	await s3Client().send(
		new PutBucketCorsCommand({
			Bucket: bucket,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedOrigins: ORIGINS,
						AllowedMethods: ["POST", "GET"],
						AllowedHeaders: ["*"],
						ExposeHeaders: ["ETag"],
						MaxAgeSeconds: 3000,
					},
				],
			},
		}),
	);
	console.log("CORS applied:", ORIGINS.join(", "));

	await s3Client().send(
		new PutBucketPolicyCommand({
			Bucket: bucket,
			Policy: JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{
						Sid: "PublicReadProductsPrefixOnly",
						Effect: "Allow",
						Principal: "*",
						Action: "s3:GetObject",
						Resource: `arn:aws:s3:::${bucket}/products/*`,
					},
				],
			}),
		}),
	);
	console.log("Bucket policy applied: public read for products/* only");

	// Read back to confirm
	const cors = await s3Client().send(new GetBucketCorsCommand({ Bucket: bucket }));
	const policy = await s3Client().send(new GetBucketPolicyCommand({ Bucket: bucket }));
	console.log("CORS rules now:", JSON.stringify(cors.CORSRules));
	console.log("Policy now:", policy.Policy);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("setupS3Bucket failed:", err?.name ?? "", err?.message ?? err);
		console.error(
			"If AccessDenied: the key lacks s3:PutBucketCORS/s3:PutBucketPolicy — apply the JSON above via the AWS console (see plan Step 0).",
		);
		process.exit(1);
	});
