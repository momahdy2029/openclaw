---
name: local-search
description: "Search the web using your local search engine (self-hosted, no API key needed). Use for web search, news, images, and more."
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["curl"] } } }
---

# Local Web Search

Self-hosted metasearch engine running locally on Docker. Aggregates results from 210+ search engines. No API key required.

## Quick Search

```bash
curl -s "http://localhost:8080/search?q=YOUR+QUERY&format=json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('results', [])[:8]:
    print(f\"- {r.get('title', 'N/A')}\")
    print(f\"  {r.get('url', '')}\")
    snippet = r.get('content', '')
    if snippet:
        print(f\"  {snippet[:200]}\")
    print()
"
```

## Parameters

| Param        | Values                                           | Example              |
| ------------ | ------------------------------------------------ | -------------------- |
| `q`          | Search query (URL-encoded)                       | `q=machine+learning` |
| `format`     | `json` (always use this)                         | `format=json`        |
| `categories` | `general`, `news`, `images`, `videos`, `science` | `categories=news`    |
| `language`   | `en`, `ar`, `ko`, `es`, `fr`, etc.               | `language=en`        |
| `time_range` | `day`, `week`, `month`, `year`                   | `time_range=week`    |
| `pageno`     | Page number (1-based)                            | `pageno=2`           |

## Examples

News from the last week:

```bash
curl -s "http://localhost:8080/search?q=AI+news&format=json&categories=news&time_range=week"
```

Science papers:

```bash
curl -s "http://localhost:8080/search?q=transformer+architecture&format=json&categories=science"
```

## Response Format

JSON response contains:

- `results[]` — Array of search results, each with:
  - `title` — Page title
  - `url` — Source URL
  - `content` — Snippet/description
  - `engine` — Which search engine returned it
  - `category` — Result category
- `number_of_results` — Total results found

## Tips

- Always use `format=json` to get structured data
- URL-encode query strings (spaces as `+` or `%20`)
- Combine categories: `categories=general,news`
- For deeper research, fetch promising URLs with `web_fetch` after searching
- Default returns ~30 results; use top 5-8 for summaries
