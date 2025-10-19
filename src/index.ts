interface Env {
	DEFAULT_REPOSITORY?: string;
	GITHUB_TOKEN?: string;
	CACHE_TTL_SECONDS?: string;
}

interface ReleaseAsset {
	name: string;
	download_count: number;
	browser_download_url: string;
}

interface Release {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	created_at: string;
	published_at: string | null;
	assets: ReleaseAsset[];
	html_url: string;
}

const GITHUB_API_BASE = 'https://api.github.com';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Max-Age': '86400',
};

const BADGE_COLOR_MAP: Record<string, string> = {
	brightgreen: '#4c1',
	green: '#97CA00',
	yellow: '#dfb317',
	yellowgreen: '#a4a61d',
	orange: '#fe7d37',
	red: '#e05d44',
	blue: '#007ec6',
	lightgrey: '#9f9f9f',
	success: '#4c1',
	important: '#fe7d37',
	critical: '#e05d44',
	informational: '#007ec6',
	inactive: '#9f9f9f',
};

const BADGE_DEFAULT_COLOR = '#0d9488';
const BADGE_HEIGHT = 28;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		if (request.method !== 'GET') {
			return json({ error: 'Method not allowed' }, 405);
		}

		const url = new URL(request.url);
		const pathSegments = getPathSegments(url);
		const wantsBadge = shouldReturnBadge(url, pathSegments);

		const owner = url.searchParams.get('owner');
		const repo = url.searchParams.get('repo');

		let repository = owner && repo ? `${owner}/${repo}` : undefined;
		if (!repository) {
			repository = env.DEFAULT_REPOSITORY;
		}

		if (!repository) {
			return json(
				{
					error: 'Missing repository. Provide owner and repo query params or set DEFAULT_REPOSITORY.',
				},
				400
			);
		}

		const cacheKey = new Request(request.url, request);
		const cache = getDefaultCache();
		const cached = await cache.match(cacheKey);
		if (cached) {
			return wantsBadge ? cached : withCors(cached);
		}

		try {
			const { owner: resolvedOwner, repo: resolvedRepo } = splitRepository(repository);
			const token = env.GITHUB_TOKEN?.trim();

			const [latestRelease, allReleases] = await Promise.all([
				fetchGitHub<Release>(`/repos/${resolvedOwner}/${resolvedRepo}/releases/latest`, token),
				fetchGitHub<Release[]>(`/repos/${resolvedOwner}/${resolvedRepo}/releases?per_page=100`, token),
			]);

			const totalDownloads = allReleases.reduce((acc, release) => {
				return acc + release.assets.reduce((assetTotal, asset) => assetTotal + asset.download_count, 0);
			}, 0);

			const latestReleaseDownloads = latestRelease.assets.reduce((acc, asset) => acc + asset.download_count, 0);

			const responsePayload = {
				repository: `${resolvedOwner}/${resolvedRepo}`,
				latest_release: {
					tag: latestRelease.tag_name,
					html_url: latestRelease.html_url,
					download_count: latestReleaseDownloads,
					assets: latestRelease.assets.map((asset) => ({
						name: asset.name,
						download_count: asset.download_count,
						browser_download_url: asset.browser_download_url,
					})),
				},
				total_downloads: totalDownloads,
				releases_counted: allReleases.length,
				fetched_at: new Date().toISOString(),
			};

			const maxAgeSeconds = parseTtl(env.CACHE_TTL_SECONDS, 300);

			if (wantsBadge) {
				const metric = getBadgeMetric(url, pathSegments);
				const label = sanitizeLabel(url.searchParams.get('label')) ?? defaultBadgeLabel(metric);
				const color = sanitizeColor(url.searchParams.get('color'));
				const displayValue = metric === 'latest' ? formatCount(latestReleaseDownloads) : formatCount(totalDownloads);
				const svg = renderBadge({
					label,
					value: displayValue,
					color,
				});
				const badge = badgeResponse(svg, maxAgeSeconds);
				ctx.waitUntil(cache.put(cacheKey, badge.clone()));
				return badge;
			}

			const response = json(responsePayload, 200, maxAgeSeconds);

			ctx.waitUntil(cache.put(cacheKey, response.clone()));
			return response;
		} catch (error) {
			return handleError(error);
		}
	},
};

async function fetchGitHub<T>(path: string, token?: string): Promise<T> {
	const response = await fetch(`${GITHUB_API_BASE}${path}`, {
		headers: {
			'User-Agent': 'repo-download-counter-worker',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});

	if (!response.ok) {
		const detail = await safeJson(response);
		throw new GitHubError(response.status, detail);
	}

	const data = await response.json();
	return data as T;
}

function json(payload: unknown, status = 200, maxAgeSeconds = 300): Response {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json; charset=UTF-8',
		'Cache-Control': `public, s-maxage=${maxAgeSeconds}`,
		...CORS_HEADERS,
	};

	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers,
	});
}

function withCors(response: Response): Response {
	const newHeaders = new Headers(response.headers);
	Object.entries(CORS_HEADERS).forEach(([key, value]) => newHeaders.set(key, value));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

function getDefaultCache(): Cache {
	const cacheStorage = caches as unknown as CacheStorage & { default: Cache };
	return cacheStorage.default;
}

function badgeResponse(svg: string, maxAgeSeconds: number): Response {
	return new Response(svg, {
		status: 200,
		headers: {
			'Content-Type': 'image/svg+xml; charset=UTF-8',
			'Cache-Control': `public, s-maxage=${maxAgeSeconds}, max-age=${maxAgeSeconds}`,
			Vary: 'Accept, Accept-Encoding',
		},
	});
}

type BadgeMetric = 'total' | 'latest';

function shouldReturnBadge(url: URL, pathSegments: string[]): boolean {
	if (pathSegments[0] === 'badge') {
		return true;
	}

	const formatParam = url.searchParams.get('format');
	if (formatParam && formatParam.toLowerCase() === 'svg') {
		return true;
	}

	return url.searchParams.get('badge') === '1';
}

function getBadgeMetric(url: URL, pathSegments: string[]): BadgeMetric {
	const routeMetric = pathSegments[0] === 'badge' ? pathSegments[1] : undefined;
	const queryMetric = url.searchParams.get('metric');
	const raw = (routeMetric ?? queryMetric ?? 'total').toLowerCase();
	return raw === 'latest' ? 'latest' : 'total';
}

function defaultBadgeLabel(metric: BadgeMetric): string {
	return metric === 'latest' ? 'latest downloads' : 'total downloads';
}

function renderBadge(options: { label: string; value: string; color: string }): string {
	const label = escapeXml(options.label);
	const value = escapeXml(options.value);
	const color = options.color;
	const padding = 9; // Equal padding on all sides
	const labelWidth = measureTextWidth(label, padding);
	const valueWidth = measureTextWidth(value, padding);
	const width = labelWidth + valueWidth;
	const height = BADGE_HEIGHT;
	const labelTextY = height / 2 + 4.5; // Better vertical centering
	const valueTextX = labelWidth + valueWidth / 2;
	const labelX = labelWidth / 2;

	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}: ${value}">` +
		`<title>${label}: ${value}</title>` +
		// Label background - flat dark gray
		`<rect width="${labelWidth}" height="${height}" fill="#555"/>` +
		// Value background - flat color
		`<rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${color}"/>` +
		// Text layer with Lato bold font
		`<g font-family="Lato,'DejaVu Sans',Verdana,Geneva,sans-serif" font-size="12.5" font-weight="700" text-rendering="geometricPrecision">` +
		// Label text - bold white
		`<text x="${labelX}" y="${labelTextY}" text-anchor="middle" fill="#ffffff">${label}</text>` +
		// Value text - bold white
		`<text x="${valueTextX}" y="${labelTextY}" text-anchor="middle" fill="#ffffff">${value}</text>` +
		`</g>` +
		`</svg>`
	);
}

function measureTextWidth(text: string, padding: number): number {
	// More accurate text width calculation for Lato bold at 12.5px
	// Average character width for Lato bold is approximately 7.5px
	const charWidth = 7.5;
	const textWidth = text.length * charWidth;
	// Apply padding on both sides (left + right = padding * 2)
	return textWidth + padding * 2;
}

function adjustColor(hex: string, amount: number): string {
	const normalized = normalizeHex(hex);
	if (!normalized) {
		return hex;
	}

	const r = clamp(parseInt(normalized.slice(1, 3), 16) + amount, 0, 255);
	const g = clamp(parseInt(normalized.slice(3, 5), 16) + amount, 0, 255);
	const b = clamp(parseInt(normalized.slice(5, 7), 16) + amount, 0, 255);

	return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function normalizeHex(hex: string): string | null {
	const match = hex.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
	if (!match) {
		return null;
	}

	const value = match[1];
	if (value.length === 3) {
		return `#${value
			.split('')
			.map((char) => char + char)
			.join('')
			.toUpperCase()}`;
	}

	return `#${value.toUpperCase()}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function componentToHex(value: number): string {
	return value.toString(16).padStart(2, '0');
}

function createSvgId(seed: string, prefix: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) {
		hash = (hash * 31 + seed.charCodeAt(i)) | 0;
	}

	return `${prefix}-${(hash >>> 0).toString(16)}`;
}

function sanitizeColor(input: string | null): string {
	if (!input) {
		return BADGE_DEFAULT_COLOR;
	}

	const color = input.trim();

	if (/^#[0-9a-fA-F]{6}$/.test(color) || /^#[0-9a-fA-F]{3}$/.test(color)) {
		return color;
	}

	const lower = color.toLowerCase();
	if (lower in BADGE_COLOR_MAP) {
		return BADGE_COLOR_MAP[lower as keyof typeof BADGE_COLOR_MAP];
	}

	return BADGE_DEFAULT_COLOR;
}

function sanitizeLabel(input: string | null): string | undefined {
	if (!input) {
		return undefined;
	}

	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}

	return trimmed.slice(0, 50);
}

function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			case "'":
				return '&apos;';
			default:
				return char;
		}
	});
}

function formatCount(value: number): string {
	if (!Number.isFinite(value)) {
		return '0';
	}

	return new Intl.NumberFormat('en-US', {
		notation: value >= 1000 ? 'compact' : 'standard',
		maximumFractionDigits: 1,
	}).format(value);
}

function getPathSegments(url: URL): string[] {
	return url.pathname.split('/').filter(Boolean);
}

function parseTtl(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitRepository(repository: string): { owner: string; repo: string } {
	const parts = repository.split('/').filter(Boolean);
	if (parts.length !== 2) {
		throw new Error('Repository must be in the form owner/repo.');
	}

	return { owner: parts[0], repo: parts[1] };
}

class GitHubError extends Error {
	status: number;
	detail: unknown;

	constructor(status: number, detail: unknown) {
		super(`GitHub API responded with status ${status}`);
		this.status = status;
		this.detail = detail;
	}
}

async function handleError(error: unknown): Promise<Response> {
	if (error instanceof GitHubError) {
		return json(
			{
				error: error.message,
				status: error.status,
				detail: error.detail,
			},
			error.status || 502
		);
	}

	console.error('Unhandled error', error);
	return json({ error: 'Internal Server Error' }, 500, 0);
}

async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.clone().json();
	} catch (jsonError) {
		try {
			return await response.clone().text();
		} catch (textError) {
			return { message: 'Failed to parse error response' };
		}
	}
}
