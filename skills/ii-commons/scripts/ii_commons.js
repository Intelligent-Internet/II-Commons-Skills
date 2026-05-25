#!/usr/bin/env node

const { readFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");

const API_ROOT = "https://commons.ii.inc";
const DEFAULT_TIMEOUT = 120;
const DEFAULT_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_SECONDS = 0.25;
const USER_AGENT = "ii-commons-skill/1";

const RESPONSE_HEADER_NAMES = [
  "x-request-id",
  "request-id",
  "x-correlation-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
  "x-usage",
  "x-usage-remaining",
  "x-usage-reset",
];

const SEARCH_OPTIONS = {
  "--categories": { property: "categories", corpora: ["arxiv", "pubmed"] },
  "--end": { property: "end", corpora: ["arxiv", "pubmed"], type: "integer" },
  "--journals": { property: "journals", corpora: ["pubmed"] },
  "--jurisdictions": { property: "jurisdictions", corpora: ["policy"] },
  "--max-results": { property: "maxResults", type: "integer" },
  "--no-refine": { property: "noRefine", type: "boolean" },
  "--no-rerank": { property: "noRerank", type: "boolean" },
  "--organizations": { property: "organizations", corpora: ["arxiv"] },
  "--snippet-chars": { property: "snippetChars", corpora: ["policy"], type: "integer" },
  "--start": { property: "start", corpora: ["arxiv", "pubmed"], type: "integer" },
};

class ClientError extends Error {
  constructor(payload, exitCode = 1) {
    super(String(payload?.message ?? payload));
    this.name = "ClientError";
    this.payload = payload;
    this.exitCode = exitCode;
  }
}

function expandLeadingTilde(value, home = homedir()) {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function configPath(env = process.env, home = homedir(), platform = process.platform) {
  if (env.XDG_CONFIG_HOME) {
    return path.join(expandLeadingTilde(env.XDG_CONFIG_HOME, home), "ii-commons", "config.json");
  }
  if (platform === "win32" && env.APPDATA) {
    return path.join(expandLeadingTilde(env.APPDATA, home), "ii-commons", "config.json");
  }
  return path.join(home, ".config", "ii-commons", "config.json");
}

function timeoutSeconds(env = process.env) {
  const raw = env.II_COMMONS_TIMEOUT;
  if (raw === undefined) {
    return DEFAULT_TIMEOUT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ClientError({
      code: "invalid_timeout",
      status: null,
      message: "II_COMMONS_TIMEOUT must be a number of seconds.",
    });
  }
  if (value <= 0) {
    throw new ClientError({
      code: "invalid_timeout",
      status: null,
      message: "II_COMMONS_TIMEOUT must be greater than zero.",
    });
  }
  return value;
}

async function loadConfig({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const filename = configPath(env, home, platform);
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new ClientError({
      code: "config_read_error",
      status: null,
      message: `Failed to read config file ${filename}: ${error.message}`,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ClientError({
      code: "config_parse_error",
      status: null,
      message: `Failed to parse config file ${filename}: ${error.message}`,
    });
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ClientError({
      code: "config_invalid",
      status: null,
      message: `Config file must contain a JSON object: ${filename}`,
    });
  }
  return parsed;
}

async function apiKeyAndSource(options = {}) {
  const env = options.env ?? process.env;
  if (env.II_COMMONS_API_KEY) {
    return [env.II_COMMONS_API_KEY, "env"];
  }

  const config = options.config ?? (await loadConfig(options));
  const configApiKey = config.api_key;
  if (configApiKey === undefined || configApiKey === null) {
    return [null, "none"];
  }
  if (typeof configApiKey !== "string" || !configApiKey.trim()) {
    throw new ClientError({
      code: "config_invalid",
      status: null,
      message: `Config field "api_key" must be a non-empty string: ${configPath(
        env,
        options.home ?? homedir(),
        options.platform ?? process.platform,
      )}`,
    });
  }
  return [configApiKey, "config"];
}

function parseCsv(value) {
  if (!value) {
    return null;
  }
  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function buildSearchPayload(args) {
  const options = {
    refine_query: !args.noRefine,
    rerank: !args.noRerank,
  };

  if (args.corpus === "arxiv") {
    const categories = parseCsv(args.categories);
    const organizations = parseCsv(args.organizations);
    if (categories) {
      options.categories = categories;
    }
    if (organizations) {
      options.organizations = organizations;
    }
    if (args.start !== undefined) {
      options.date_range_start = args.start;
    }
    if (args.end !== undefined) {
      options.date_range_end = args.end;
    }
  } else if (args.corpus === "pubmed") {
    const categories = parseCsv(args.categories);
    const journals = parseCsv(args.journals);
    if (categories) {
      options.categories = categories;
    }
    if (journals) {
      options.journal = journals;
    }
    if (args.start !== undefined) {
      options.date_range_start = args.start;
    }
    if (args.end !== undefined) {
      options.date_range_end = args.end;
    }
  } else if (args.corpus === "policy") {
    const jurisdictions = parseCsv(args.jurisdictions);
    if (jurisdictions) {
      options.jurisdictions = jurisdictions;
    }
    if (args.snippetChars !== undefined) {
      options.snippet_chars = args.snippetChars;
    }
  }

  return {
    topic: args.topic,
    max_results: args.maxResults,
    options,
  };
}

function responseMetadata(headers) {
  const metadata = {};
  for (const name of RESPONSE_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null) {
      metadata[name] = value;
    }
  }
  return metadata;
}

function attachResponseMetadata(body, metadata) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return body;
  }
  if (body !== null && !Array.isArray(body) && typeof body === "object") {
    return { ...body, _response: metadata };
  }
  return { data: body, _response: metadata };
}

function errorPayload(status, body, { code = null, metadata = null } = {}) {
  const payload = {
    code: code ?? (status !== null && status !== undefined ? `http_${status}` : "request_error"),
    status,
    message: String(body ?? "").trim() || "Request failed.",
  };
  if (status === 401 || status === 403) {
    payload.hint = "This request may require an API token, or the configured token may have been rejected.";
    payload.auth = "required_or_rejected";
  } else if (status === 402) {
    payload.hint = "The account may require higher usage limits or billing changes.";
    payload.payment = "required";
  } else if (status === 429) {
    payload.hint = "Rate limit exceeded. Retry after the service reset window.";
    payload.rate_limit = "exceeded";
  }
  if (metadata && Object.keys(metadata).length > 0) {
    payload._response = metadata;
  }
  return payload;
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function isTimeoutError(error) {
  return error?.name === "AbortError" || error?.code === "ETIMEDOUT" || error?.cause?.code === "ETIMEDOUT";
}

function isRetryableNetworkError(error) {
  return isTimeoutError(error) || error?.code === "EAI_AGAIN" || error?.cause?.code === "EAI_AGAIN";
}

function networkMessage(error) {
  if (error?.cause?.code && error?.cause?.message) {
    return `${error.cause.code}: ${error.cause.message}`;
  }
  if (error?.code && error?.message) {
    return `${error.code}: ${error.message}`;
  }
  return error?.message ?? String(error);
}

function assertFetchAvailable(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new ClientError({
      code: "incompatible_node_runtime",
      status: null,
      message: "Node.js 18 or newer is required because this client uses the built-in fetch API.",
    });
  }
}

async function requestJson(
  method,
  requestPath,
  {
    payload = null,
    tolerate404 = false,
    env = process.env,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    authOptions = {},
  } = {},
) {
  assertFetchAvailable(fetchImpl);

  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const requestOptions = { method, headers };
  if (payload !== null) {
    requestOptions.body = JSON.stringify(payload);
    headers["Content-Type"] = "application/json";
  }

  const [apiKey] = await apiKeyAndSource({ env, ...authOptions });
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const timeout = timeoutSeconds(env);
  for (let attempt = 1; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetchImpl(`${API_ROOT}${requestPath}`, {
        ...requestOptions,
        signal: controller.signal,
      });
      const metadata = responseMetadata(response.headers);
      const text = await response.text();
      if (!response.ok) {
        if (tolerate404 && response.status === 404) {
          return null;
        }
        throw new ClientError(errorPayload(response.status, text, { metadata }));
      }
      const body = text ? JSON.parse(text) : {};
      return attachResponseMetadata(body, metadata);
    } catch (error) {
      if (error instanceof ClientError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new ClientError({
          code: "invalid_json",
          status: null,
          message: `Response was not valid JSON: ${error.message}`,
        });
      }
      if (attempt < DEFAULT_RETRY_ATTEMPTS && isRetryableNetworkError(error)) {
        await sleepImpl(RETRY_BACKOFF_SECONDS * attempt);
        continue;
      }
      if (isTimeoutError(error)) {
        throw new ClientError({
          code: "timeout",
          status: null,
          message: `Request timed out after ${timeoutSeconds(env)} seconds.`,
        });
      }
      throw new ClientError({
        code: "network_error",
        status: null,
        message: `Request failed: ${networkMessage(error)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Request retry loop exited unexpectedly.");
}

function parseArgs(argv) {
  const tokens = [...argv];
  const command = tokens.shift();
  if (!command || command === "-h" || command === "--help") {
    return { command: "help" };
  }

  if (command === "cutoff" || command === "usage") {
    rejectExtra(tokens);
    return { command };
  }

  if (command === "auth") {
    const authCommand = tokens.shift();
    if (authCommand !== "status") {
      throw usageError("auth requires the status subcommand.");
    }
    rejectExtra(tokens);
    return { command, authCommand };
  }

  if (command === "meta" || command === "markdown") {
    const identifier = tokens.shift();
    if (!identifier) {
      throw usageError(`${command} requires an identifier.`);
    }
    rejectExtra(tokens);
    return { command, identifier };
  }

  if (command === "search") {
    const corpus = tokens.shift();
    if (!["arxiv", "pubmed", "policy"].includes(corpus)) {
      throw usageError("search requires a corpus: arxiv, pubmed, or policy.");
    }
    const args = {
      command,
      corpus,
      topic: null,
      maxResults: 10,
      noRefine: false,
      noRerank: false,
    };
    parseSearchArgs(args, tokens);
    if (!args.topic) {
      throw usageError(`search ${corpus} requires a topic.`);
    }
    return args;
  }

  throw usageError(`Unknown command: ${command}`);
}

function parseSearchArgs(args, tokens) {
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (!token.startsWith("--")) {
      if (args.topic !== null) {
        throw usageError(`Unexpected argument: ${token}`);
      }
      args.topic = token;
      continue;
    }

    const { option, inlineValue } = splitOption(token);
    const spec = SEARCH_OPTIONS[option];
    if (!spec) {
      throw usageError(`Unknown option: ${option}`);
    }
    if (spec.corpora) {
      ensureCorpusAllows(args.corpus, option, spec.corpora);
    }
    if (spec.type === "boolean") {
      if (inlineValue !== undefined) {
        throw usageError(`${option} does not take a value.`);
      }
      args[spec.property] = true;
      continue;
    }

    const rawValue = inlineValue ?? tokens.shift();
    args[spec.property] =
      spec.type === "integer"
        ? parseIntegerOption(option, rawValue)
        : requireOptionValue(option, rawValue);
  }
}

function splitOption(token) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex === -1) {
    return { option: token, inlineValue: undefined };
  }
  return {
    option: token.slice(0, equalsIndex),
    inlineValue: token.slice(equalsIndex + 1),
  };
}

function ensureCorpusAllows(corpus, option, allowed) {
  if (!allowed.includes(corpus)) {
    throw usageError(`${option} is not valid for ${corpus}.`);
  }
}

function parseIntegerOption(option, value) {
  const raw = requireOptionValue(option, value);
  if (!/^-?\d+$/.test(raw)) {
    throw usageError(`${option} must be an integer.`);
  }
  return Number.parseInt(raw, 10);
}

function requireOptionValue(option, value) {
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw usageError(`${option} requires a value.`);
  }
  return value;
}

function rejectExtra(tokens) {
  if (tokens.length > 0) {
    throw usageError(`Unexpected argument: ${tokens[0]}`);
  }
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

async function runCommand(args, options = {}) {
  if (args.command === "help") {
    return usageText();
  }
  if (args.command === "search") {
    return requestJson("POST", `/api/query/${args.corpus}`, {
      ...options,
      payload: buildSearchPayload(args),
    });
  }
  if (args.command === "meta") {
    return requestJson("GET", `/api/meta/${encodeURIComponent(args.identifier)}`, options);
  }
  if (args.command === "markdown") {
    return requestJson("GET", `/api/markdown/json/${encodeURIComponent(args.identifier)}`, options);
  }
  if (args.command === "cutoff") {
    return requestJson("GET", "/api/knowledge/cutoff", options);
  }
  if (args.command === "usage") {
    const result = await requestJson("GET", "/api/usage", { ...options, tolerate404: true });
    if (result === null) {
      throw new ClientError({
        code: "usage_endpoint_not_found",
        status: 404,
        message: "The II-Commons service did not expose /api/usage.",
      });
    }
    return result;
  }
  if (args.command === "auth" && args.authCommand === "status") {
    const authOptions = options.authOptions ?? {};
    const [, source] = await apiKeyAndSource({ env: options.env ?? process.env, ...authOptions });
    const local = {
      token_source: source,
      authenticated_locally: source === "env" || source === "config",
    };
    try {
      const service = await requestJson("GET", "/api/auth/status", { ...options, tolerate404: true });
      local.service = service ?? {
        available: false,
        message: "The II-Commons service did not expose /api/auth/status.",
      };
    } catch (error) {
      if (!(error instanceof ClientError)) {
        throw error;
      }
      local.service = {
        available: false,
        error: error.payload,
      };
    }
    return local;
  }
  throw usageError(`Unknown command: ${args.command}`);
}

function usageText() {
  return [
    "Usage:",
    "  ii-commons cutoff",
    "  ii-commons search <arxiv|pubmed|policy> <topic> [options]",
    "  ii-commons meta <identifier>",
    "  ii-commons markdown <identifier>",
    "  ii-commons auth status",
    "  ii-commons usage",
    "",
    "Search options:",
    "  --max-results N",
    "  --no-refine",
    "  --no-rerank",
    "  --categories CSV        arxiv, pubmed",
    "  --organizations CSV     arxiv",
    "  --journals CSV          pubmed",
    "  --start YYYYMMDD        arxiv, pubmed",
    "  --end YYYYMMDD          arxiv, pubmed",
    "  --jurisdictions CSV     policy",
    "  --snippet-chars N       policy",
  ].join("\n");
}

function dumpJson(payload, stream) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${usageText()}\n`);
    return error.exitCode ?? 2;
  }

  try {
    const result = await runCommand(args);
    if (typeof result === "string") {
      stdout.write(`${result}\n`);
    } else {
      dumpJson(result, stdout);
    }
    return 0;
  } catch (error) {
    if (error instanceof ClientError) {
      dumpJson(error.payload, stderr);
      return error.exitCode;
    }
    dumpJson(
      {
        code: "unexpected_error",
        status: null,
        message: error?.message ?? String(error),
      },
      stderr,
    );
    return 1;
  }
}

module.exports = {
  API_ROOT,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_TIMEOUT,
  RETRY_BACKOFF_SECONDS,
  USER_AGENT,
  ClientError,
  apiKeyAndSource,
  attachResponseMetadata,
  buildSearchPayload,
  configPath,
  dumpJson,
  errorPayload,
  loadConfig,
  main,
  parseArgs,
  parseCsv,
  requestJson,
  responseMetadata,
  runCommand,
  timeoutSeconds,
  usageText,
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
