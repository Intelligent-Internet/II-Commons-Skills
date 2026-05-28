# II-Commons-Skills

[![Web App](https://img.shields.io/badge/web%20app-commons.ii.inc-0E7C66)](https://commons.ii.inc/)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Intelligent-Internet/II-Commons-Skills?style=social)](https://github.com/Intelligent-Internet/II-Commons-Skills)

![II-Commons-Skills banner](github-commons-skill.jpg)

II-Commons-Skills provides fast, daily-updated deterministic retrieval across arXiv, PubMed / PMC, and supported US policy corpora.

## Links

- Web app and API token requests: https://commons.ii.inc/
- Source repository: https://github.com/Intelligent-Internet/II-Commons-Skills
- Retrieval engine: [psql_bm25s](https://github.com/Intelligent-Internet/psql_bm25s), a PostgreSQL BM25S extension powering fast lexical retrieval.

## For Humans: How to Use It

Send this to your agent:

```txt
Please add this skill for me:
https://github.com/Intelligent-Internet/II-Commons-Skills.git
And tell me the value of this skill.
```

After the skill is installed, use it through your agent:

```txt
Please use the `ii-commons` skill to answer this: <your question or topic>...
```

## For Agents: How to Use It

### Install

The npm package is published as `@intelligentinternet/ii-commons`.

Run the CLI with npx:

```bash
npx @intelligentinternet/ii-commons cutoff
```

Or install it globally:

```bash
npm install -g @intelligentinternet/ii-commons
ii-commons cutoff
```

The CLI requires Node.js 18 or newer.

To install as an agent skill, install the `skills/ii-commons/` folder as a skill named `ii-commons` in your agent runtime's native skill discovery path. If your runtime supports repository URL installs, point it at `skills/ii-commons/`.

```bash
node scripts/ii_commons.js --help
```

### Usage

For `search`, use exactly this shape: `search <corpus> <topic> [filters]`. Put the quoted topic immediately after the corpus, then append filters.

```bash
ii-commons cutoff
ii-commons search arxiv "large language model inference" --max-results 10
ii-commons search pubmed "type 2 diabetes review" --start 20240000 --max-results 10
ii-commons search policy "state overtime rule for agricultural workers" --jurisdictions US-CA --max-results 10
ii-commons meta "arXiv:2402.03578"
ii-commons markdown "PMCID:PMC11152602"
```

`cutoff` returns the latest available corpus coverage date for each corpus. For freshness-sensitive requests, run `cutoff` first and report the returned date.

The CLI writes JSON to stdout. Errors are machine-readable JSON on stderr.

### Auth

Basic usage works without authentication. For higher usage limits, request an API token at https://commons.ii.inc/ and configure it with `II_COMMONS_API_KEY` or the local `ii-commons` config file.

## License

[Apache-2.0. ](LICENSE).
