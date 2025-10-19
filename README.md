# Repo Download Counter

This Cloudflare Worker exposes download statistics for a GitHub repository's releases. It returns the total download count across releases alongside the latest release's counts and assets.

## Features

- Fetches live data from the GitHub REST API.
- Sums download counts for every asset in the latest release and across the first 100 releases.
- Supports optional GitHub token for higher rate limits.
- Caches responses using the Cloudflare Workers cache API.
- CORS-enabled JSON responses for easy integration in dashboards or webpages.

## Setup

1. Install dependencies:

   ```pwsh
   npm install
   ```

2. **Generate a GitHub Token** (Optional but recommended):

   A GitHub token increases your API rate limits from 60 to 5,000 requests per hour and allows access to private repositories.

   ### Creating a Personal Access Token (Classic)

   1. Go to [GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)](https://github.com/settings/tokens)
   2. Click **"Generate new token"** → **"Generate new token (classic)"**
   3. Give your token a descriptive name (e.g., "Cloudflare Worker - Download Counter")
   4. Set an expiration date (recommended: 90 days or custom)
   5. Select **no scopes** for public repositories (read-only access is default)
      - For private repositories, check `repo` scope
   6. Click **"Generate token"** at the bottom
   7. **Copy the token immediately** (you won't be able to see it again!)

   ### Creating a Fine-grained Personal Access Token (Recommended)

   1. Go to [GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens?type=beta)
   2. Click **"Generate new token"**
   3. Fill in the token details:
      - **Name**: "Cloudflare Worker - Download Counter"
      - **Expiration**: 90 days or custom
      - **Repository access**: 
        - Choose "Public Repositories (read-only)" for public repos
        - Or select specific repositories if needed
   4. **Permissions**: 
      - For public repositories: No additional permissions needed (read-only metadata is automatic)
      - For private repositories: Set **Repository permissions** → **Metadata** → **Read-only**
   5. Click **"Generate token"**
   6. **Copy the token immediately**

3. Configure Wrangler bindings. Set environment variables:

   ```pwsh
   wrangler secret put GITHUB_TOKEN
   ```

   When prompted, paste your GitHub token.

   Optional plain-text bindings can be added under the `[vars]` section of `wrangler.toml`:

   ```toml
   [vars]
   DEFAULT_REPOSITORY = "cloudflare/wrangler"
   CACHE_TTL_SECONDS = "300"
   ```

4. Start the development server:

   ```pwsh
   npm run dev
   ```

   The local worker responds on the URL printed by Wrangler. Query parameters override the default repository:

   - `owner`: GitHub account or organization name.
   - `repo`: Repository name.

   Example request:

   ```pwsh
   curl "http://127.0.0.1:8787/?owner=cloudflare&repo=wrangler"
   ```

5. Deploy to Cloudflare:

   ```pwsh
   npm run deploy
   ```

## Badge Usage

Embed the badge in any README or dashboard by pointing an image tag to the worker's `/badge` route. Pass `owner` and `repo` parameters or rely on the configured `DEFAULT_REPOSITORY`.

```markdown
![GitHub downloads](https://<your-worker-subdomain>.workers.dev/badge?owner=cloudflare&repo=wrangler)
```

Optional query parameters:

- `metric`: `total` (default) or `latest` to switch between the total downloads across releases or just the latest release.
- `label`: Custom text on the left side of the badge (max 50 characters).
- `color`: Hex color (e.g. `%230d9488`) or a Shields-style keyword (`green`, `orange`, etc.).
- `badge=1` or `format=svg`: alternate ways to request the SVG badge on non-`/badge` routes.
- `/badge/latest` path shorthand: omit `metric` by placing it in the path.

## API Response

A successful response is JSON with the following structure:

```json
{
  "repository": "owner/repo",
  "latest_release": {
    "tag": "v1.0.0",
    "html_url": "https://github.com/owner/repo/releases/tag/v1.0.0",
    "download_count": 1234,
    "assets": [
      {
        "name": "artifact.zip",
        "download_count": 1234,
        "browser_download_url": "https://github.com/..."
      }
    ]
  },
  "total_downloads": 4321,
  "releases_counted": 3,
  "fetched_at": "2025-10-19T12:34:56.789Z"
}
```

## GitHub API Rate Limits

| Authentication        | Rate Limit          | Best For       |
| --------------------- | ------------------- | -------------- |
| No token              | 60 requests/hour    | Testing only   |
| Personal Access Token | 5,000 requests/hour | Production use |

**Recommendation**: Always use a GitHub token in production to avoid rate limit errors.

## Notes

- The worker fetches up to the most recent 100 releases due to GitHub's paging limits. Increase coverage by adding pagination if the repository has more releases.
- Attach a GitHub token to avoid strict anonymous rate limits (60/hour) and to access private repositories (with proper scopes).
- Adjust `CACHE_TTL_SECONDS` to control how long responses stay in the edge cache.
- Fine-grained tokens are more secure than classic tokens as they have stricter permissions and expiration enforcement.
