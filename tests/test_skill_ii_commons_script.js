const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const packageJson = require("../package.json");

const {
  ClientError,
  apiKeyAndSource,
  buildSearchPayload,
  configPath,
  errorPayload,
  parseArgs,
  requestJson,
  runCommand,
} = require("../skills/ii-commons/scripts/ii_commons.js");

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), "ii-commons-test-"));
}

test("npm package exposes the ii-commons CLI", async () => {
  assert.equal(packageJson.name, "@intelligentinternet/ii-commons");
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org",
  });
  assert.deepEqual(packageJson.bin, {
    "ii-commons": "skills/ii-commons/scripts/ii_commons.js",
  });
  assert.equal(packageJson.engines.node, ">=18");

  const script = await readFile(
    path.join(__dirname, "..", packageJson.bin["ii-commons"]),
    "utf8",
  );
  assert.equal(script.split(/\r?\n/, 1)[0], "#!/usr/bin/env node");
});

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), init);
}

test("auth source prefers env over config", async () => {
  const home = await tempHome();
  const configPath = path.join(home, ".config", "ii-commons", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{"api_key": "from-config"}', "utf8");

  const [token, source] = await apiKeyAndSource({
    env: { II_COMMONS_API_KEY: "from-env" },
    home,
  });

  assert.equal(token, "from-env");
  assert.equal(source, "env");
});

test("auth source uses config when env is missing", async () => {
  const home = await tempHome();
  const configPath = path.join(home, ".config", "ii-commons", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{"api_key": "from-config"}', "utf8");

  const [token, source] = await apiKeyAndSource({ env: {}, home });

  assert.equal(token, "from-config");
  assert.equal(source, "config");
});

test("auth source uses XDG_CONFIG_HOME when present", async () => {
  const home = await tempHome();
  const configRoot = path.join(home, "xdg");
  const configPath = path.join(configRoot, "ii-commons", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{"api_key": "from-xdg"}', "utf8");

  const [token, source] = await apiKeyAndSource({ env: { XDG_CONFIG_HOME: configRoot }, home });

  assert.equal(token, "from-xdg");
  assert.equal(source, "config");
});

test("config path expands leading tilde in config roots", () => {
  const home = path.join(os.tmpdir(), "ii-commons-home");

  assert.equal(
    configPath({ XDG_CONFIG_HOME: "~/.config" }, home),
    path.join(home, ".config", "ii-commons", "config.json"),
  );
  assert.equal(
    configPath({ APPDATA: "~/AppData/Roaming" }, home, "win32"),
    path.join(home, "AppData", "Roaming", "ii-commons", "config.json"),
  );
});

test("search payload for arxiv filters", () => {
  const payload = buildSearchPayload({
    corpus: "arxiv",
    topic: "agent systems",
    maxResults: 7,
    categories: "cs.AI, cs.CL",
    organizations: "OpenAI,MIT",
    start: 20240100,
    end: 20250100,
    noRefine: true,
    noRerank: false,
  });

  assert.deepEqual(payload, {
    topic: "agent systems",
    max_results: 7,
    options: {
      refine_query: false,
      rerank: true,
      categories: ["cs.AI", "cs.CL"],
      organizations: ["OpenAI", "MIT"],
      date_range_start: 20240100,
      date_range_end: 20250100,
    },
  });
});

test("search posts expected request and returns success JSON metadata", async () => {
  const captured = {};
  const args = parseArgs([
    "search",
    "arxiv",
    "llm inference",
    "--max-results",
    "3",
    "--categories",
    "cs.LG",
  ]);

  const result = await runCommand(args, {
    env: { II_COMMONS_API_KEY: "secret" },
    fetchImpl: async (url, options) => {
      captured.url = url;
      captured.method = options.method;
      captured.body = JSON.parse(options.body);
      captured.headers = options.headers;
      return jsonResponse(
        { documents: [{ id: "arXiv:1234.5678" }] },
        {
          headers: {
            "x-request-id": "req-1",
            "x-ratelimit-remaining": "9",
          },
        },
      );
    },
    authOptions: { config: {} },
  });

  assert.equal(captured.url, "https://commons.ii.inc/api/query/arxiv");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.Authorization, "Bearer secret");
  assert.equal(captured.body.max_results, 3);
  assert.deepEqual(captured.body.options.categories, ["cs.LG"]);
  assert.equal(result._response["x-request-id"], "req-1");
  assert.equal(result._response["x-ratelimit-remaining"], "9");
});

test("search rejects invalid filter for policy", () => {
  assert.throws(
    () => parseArgs(["search", "policy", "paid sick leave", "--categories", "Review"]),
    (error) => error.exitCode === 2 && error.message.includes("--categories"),
  );
});

test("search parser accepts options before topic and inline option values", () => {
  const args = parseArgs([
    "search",
    "arxiv",
    "--max-results=3",
    "--categories",
    "cs.LG",
    "llm inference",
    "--no-refine",
  ]);

  assert.deepEqual(args, {
    command: "search",
    corpus: "arxiv",
    topic: "llm inference",
    maxResults: 3,
    noRefine: true,
    noRerank: false,
    categories: "cs.LG",
  });
});

test("search parser rejects inline values for boolean options", () => {
  assert.throws(
    () => parseArgs(["search", "arxiv", "llm inference", "--no-refine=true"]),
    (error) => error.exitCode === 2 && error.message.includes("--no-refine"),
  );
});

test("request reports incompatible runtime when fetch is unavailable", async () => {
  await assert.rejects(
    requestJson("GET", "/api/knowledge/cutoff", {
      authOptions: { config: {} },
      fetchImpl: null,
    }),
    (error) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.payload.code, "incompatible_node_runtime");
      assert.match(error.payload.message, /Node\.js 18 or newer/);
      return true;
    },
  );
});

test("request retries temporary DNS failure", async () => {
  let calls = 0;
  let sleeps = 0;

  const result = await requestJson("GET", "/api/markdown/json/arXiv%3Aretry", {
    authOptions: { config: {} },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("Temporary failure in name resolution"), { code: "EAI_AGAIN" });
      }
      return jsonResponse({ documents: [{ id: "arXiv:retry" }] });
    },
    sleepImpl: async () => {
      sleeps += 1;
    },
  });

  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
  assert.equal(result.documents[0].id, "arXiv:retry");
});

test("request retries Node fetch temporary DNS failure cause", async () => {
  let calls = 0;

  const result = await requestJson("GET", "/api/markdown/json/arXiv%3Aretry", {
    authOptions: { config: {} },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 2) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("getaddrinfo EAI_AGAIN commons.ii.inc"), { code: "EAI_AGAIN" }),
        });
      }
      return jsonResponse({ documents: [{ id: "arXiv:retry" }] });
    },
    sleepImpl: async () => {},
  });

  assert.equal(calls, 2);
  assert.equal(result.documents[0].id, "arXiv:retry");
});

test("request returns network error after retry exhaustion", async () => {
  let sleeps = 0;

  await assert.rejects(
    requestJson("GET", "/api/markdown/json/arXiv%3Aretry", {
      authOptions: { config: {} },
      fetchImpl: async () => {
        throw Object.assign(new Error("Temporary failure in name resolution"), { code: "EAI_AGAIN" });
      },
      sleepImpl: async () => {
        sleeps += 1;
      },
    }),
    (error) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.payload.code, "network_error");
      assert.match(error.payload.message, /Temporary failure in name resolution/);
      return true;
    },
  );
  assert.equal(sleeps, 2);
});

test("request returns timeout after retry exhaustion", async () => {
  let sleeps = 0;

  await assert.rejects(
    requestJson("GET", "/api/markdown/json/arXiv%3Aretry", {
      authOptions: { config: {} },
      fetchImpl: async () => {
        throw Object.assign(new Error("timed out"), { name: "AbortError" });
      },
      sleepImpl: async () => {
        sleeps += 1;
      },
    }),
    (error) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.payload.code, "timeout");
      assert.match(error.payload.message, /Request timed out after/);
      return true;
    },
  );
  assert.equal(sleeps, 2);
});

test("HTTP auth error payload is machine readable", async () => {
  await assert.rejects(
    requestJson("GET", "/api/meta/arXiv%3A1", {
      authOptions: { config: {} },
      fetchImpl: async () => new Response('{"detail":"bad token"}', { status: 401 }),
    }),
    (error) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.payload.code, "http_401");
      assert.equal(error.payload.status, 401);
      assert.equal(error.payload.auth, "required_or_rejected");
      return true;
    },
  );
});

test("HTTP error payload preserves rate-limit metadata", () => {
  const payload = errorPayload(429, "slow down", {
    metadata: { "retry-after": "30", "x-request-id": "req-2" },
  });

  assert.deepEqual(payload, {
    code: "http_429",
    status: 429,
    message: "slow down",
    hint: "Rate limit exceeded. Retry after the service reset window.",
    rate_limit: "exceeded",
    _response: {
      "retry-after": "30",
      "x-request-id": "req-2",
    },
  });
});
