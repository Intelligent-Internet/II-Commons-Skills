# II-Commons Agent REST Client Contract

The `ii-commons` CLI is the supported command-line client for II-Commons retrieval. It ships as `@intelligentinternet/ii-commons` and uses a dependency-free Node.js 18+ REST client.

## Contents

- [Service And Auth](#service-and-auth)
- [Client Contract](#client-contract)
- [Endpoint Mapping](#endpoint-mapping)
- [Output](#output)
- [Auth Diagnostics](#auth-diagnostics)
- [Usage And Rate Limits](#usage-and-rate-limits)
- [Errors](#errors)
- [Runtime](#runtime)

## Service And Auth

Web app and API token requests: https://commons.ii.inc/

API root: `https://commons.ii.inc/api`

Basic usage works without authentication. For higher usage limits, request an API token in the web app and configure it locally.

Supported token configuration:

- `II_COMMONS_API_KEY` environment variable
- local config file with `{"api_key": "..."}` at `$XDG_CONFIG_HOME/ii-commons/config.json`, `%APPDATA%\ii-commons\config.json` on Windows, or `~/.config/ii-commons/config.json` by default

`II_COMMONS_API_KEY` takes precedence over the local config file. The client never prints token values.

## Client Contract

The CLI exposes stable command names that map to the REST endpoints below:

```bash
ii-commons search <corpus> <topic> --max-results N
ii-commons meta <identifier>
ii-commons markdown <identifier>
ii-commons cutoff
```

For `search`, the client accepts a corpus, a topic, and optional filters, then translates them into the JSON request body shown below.

Supported corpora are `arxiv`, `pubmed`, and `policy`.

`cutoff` returns the authoritative latest available cutoff date for each corpus. Use those dates to describe daily-updated corpus freshness.

Search filters:

- arXiv: `--categories`, `--organizations`, `--start`, `--end`, `--no-refine`, `--no-rerank`
- PubMed: `--categories`, `--journals`, `--start`, `--end`, `--no-refine`, `--no-rerank`
- Policy: `--jurisdictions`, `--snippet-chars`, `--no-refine`, `--no-rerank`

Comma-separated filter values are sent as JSON arrays. Date filters use the existing II-Commons integer formats such as `YYYYMMDD`, `YYYYMM00`, or `YYYY0000`.

## Endpoint Mapping

| Command | Method | Endpoint |
| --- | --- | --- |
| `search arxiv` | `POST` | `/api/query/arxiv` |
| `search pubmed` | `POST` | `/api/query/pubmed` |
| `search policy` | `POST` | `/api/query/policy` |
| `meta <identifier>` | `GET` | `/api/meta/{urlencoded_identifier}` |
| `markdown <identifier>` | `GET` | `/api/markdown/json/{urlencoded_identifier}` |
| `cutoff` | `GET` | `/api/knowledge/cutoff` |
| `usage` | `GET` | `/api/usage` when exposed by the service |

Search request body:

```json
{
  "topic": "large language model inference",
  "max_results": 10,
  "options": {
    "refine_query": true,
    "rerank": true
  }
}
```

## Output

All successful commands write JSON to stdout. `markdown` also writes the service JSON as-is; if the service returns a `markdown` or `content` field, the client does not convert it to pretty text.

When response headers include request, rate-limit, or usage metadata, the client attaches them under `_response`:

```json
{
  "documents": [],
  "_response": {
    "x-request-id": "req_...",
    "x-ratelimit-remaining": "99"
  }
}
```

If the service returns a non-object JSON value, the client wraps it as:

```json
{
  "data": [],
  "_response": {
    "x-request-id": "req_..."
  }
}
```

## Auth Diagnostics

The optional `auth status` command calls `/api/auth/status` when the service exposes it. This helper is only for local diagnostics and is not part of the normal public usage path.

## Usage And Rate Limits

`usage` is optional. The client calls `/api/usage` when that endpoint is exposed by the service. If the endpoint is unavailable and returns `404`, the client returns a non-zero exit with:

```json
{
  "code": "usage_endpoint_not_found",
  "status": 404,
  "message": "The II-Commons service did not expose /api/usage."
}
```

Rate-limit headers such as `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, and `retry-after` are preserved in `_response` when present.

## Errors

Errors write machine-readable JSON to stderr and return non-zero:

```json
{
  "code": "http_401",
  "status": 401,
  "message": "{\"detail\":\"bad token\"}",
  "hint": "This request may require an API token, or the configured token may have been rejected.",
  "auth": "required_or_rejected"
}
```

Special status handling:

- `401` / `403`: API token required, rejected, or insufficient permissions
- `402`: higher usage limits or billing action required
- `429`: rate limit exceeded
- network errors: `code` is `network_error`, `status` is `null`
- invalid JSON: `code` is `invalid_json`, `status` is `null`
