/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

/**
 * Cloudflare Worker for generating R2 presigned URLs with CORS support.
 */

// Define allowed origins - add your production frontend URL if applicable
const allowedOrigins = [
	'http://localhost:3000', // Example: Common local dev server port
	'http://localhost:8787', // Example: Wrangler dev server default
	'tauri://localhost', // Tauri application origin
	// 'https://your-production-app.com' // Add your production frontend URL here
];

// Function to create CORS headers based on request origin
function createCorsHeaders(requestOrigin: string | null): Headers {
	const headers = new Headers();

	// Check if the request origin is allowed
	const originAllowed = requestOrigin && allowedOrigins.includes(requestOrigin);

	if (originAllowed) {
		headers.set('Access-Control-Allow-Origin', requestOrigin);
	} else {
		// Fallback or default - you might restrict this further in production
		// For now, let's allow generally if the list includes '*' or if debugging
		headers.set('Access-Control-Allow-Origin', '*'); // Be cautious with wildcard in production
	}

	headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Add 'Authorization' or other headers if needed
	headers.set('Access-Control-Max-Age', '86400'); // Cache preflight response for 1 day

	return headers;
}

// Handler for OPTIONS preflight requests
function handleOptions(request: Request): Response {
	const origin = request.headers.get('Origin');
	const headers = createCorsHeaders(origin);
	return new Response(null, { headers: headers });
}

// Main fetch handler
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const origin = request.headers.get('Origin');
	const corsHeaders = createCorsHeaders(origin);

	try {
		// --- Placeholder for your R2 Signed URL Generation Logic ---
		// 1. Get parameters from the request (e.g., desired filename, content type)
		const urlParams = new URL(request.url).searchParams;
		const filename = urlParams.get('filename') || `upload-${Date.now()}.jpg`; // Use a default/dynamic filename
		const contentType = urlParams.get('contentType') || 'application/octet-stream'; // Default content type

		// 2. Ensure R2 bucket binding is configured in wrangler.jsonc and Env interface
		if (!env.R2_BUCKET) {
			// Using the binding name from wrangler.jsonc
			throw new Error("R2 bucket binding 'R2_BUCKET' not found or configured.");
		}
		if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
			throw new Error('One or more R2 environment variables (ACCOUNT_ID, ACCESS_KEY_ID, SECRET_ACCESS_KEY, BUCKET_NAME) are missing.');
		}

		// 3. Generate the presigned POST URL
		// Make sure @aws-sdk/s3-presigned-post and @aws-sdk/client-s3 are installed
		console.log('Initializing S3 Client for R2...'); // Log client init
		const s3Client = new S3Client({
			region: 'auto',
			endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: env.R2_ACCESS_KEY_ID,
				secretAccessKey: env.R2_SECRET_ACCESS_KEY,
			},
		});
		console.log('S3 Client Initialized.'); // Log success

		console.log(`Generating presigned POST for Bucket: ${env.R2_BUCKET_NAME}, Key: ${filename}, ContentType: ${contentType}`); // Log params

		const { url, fields } = await createPresignedPost(s3Client, {
			Bucket: env.R2_BUCKET_NAME,
			Key: filename, // Use the desired filename/key
			Conditions: [
				// Add conditions like content length range, content type etc.
				['content-length-range', 0, 10485760], // Example: 10MB limit
				// ["starts-with", "$Content-Type", contentType], // Content-Type check can sometimes cause issues, consider removing if debugging
			],
			Fields: {
				// Fields required by R2/S3 - Content-Type might be automatically added or required here
				'Content-Type': contentType, // Ensure this matches what the client sends
			},
			Expires: 3600, // URL expiration time in seconds (e.g., 1 hour)
		});

		// --- LOGGING ADDED HERE ---
		console.log('Generated Presigned URL:', url);
		console.log('Generated Form Fields:', JSON.stringify(fields, null, 2));
		// --- END LOGGING ---

		const responseBody = JSON.stringify({ uploadUrl: url, formData: fields });
		// --- End of Placeholder ---

		// Replace this with your actual response once R2 logic is added
		return new Response(responseBody, {
			status: 200,
			headers: corsHeaders, // Apply CORS headers to the main response
		});
	} catch (error) {
		console.error('Worker error:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
		// Return error response with CORS headers
		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 500,
			headers: corsHeaders, // Apply CORS headers even to error responses
		});
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Handle OPTIONS preflight requests
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}
		// Handle actual GET/POST/etc. requests
		return handleRequest(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

// Define the Env interface based on wrangler.jsonc bindings
// Remember to run `npm run cf-typegen` after updating bindings
interface Env {
	// MY_R2_BUCKET: R2Bucket; // Example R2 binding name - CHANGE THIS <-- Using R2_BUCKET now
	R2_BUCKET: R2Bucket; // <--- Ensure this matches the binding name in wrangler.jsonc
	R2_ACCOUNT_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_BUCKET_NAME: string;
	// Add other bindings/secrets if needed
}
