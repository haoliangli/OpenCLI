# web

Generic browser-backed article reader for arbitrary URLs.

## Commands

| Command | Description |
|---------|-------------|
| `opencli web read <url>` | Fetch a web page and export the main content as Markdown |

## Examples

```bash
# Save an arbitrary article as Markdown
opencli web read "https://www.anthropic.com/research/..." --output ./articles

# Skip local image download
opencli web read "https://openai.com/index/..." --download-images false

# Wait a bit longer for JS-rendered pages
opencli web read "https://example.com/post" --wait 5
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `<url>` | required | Target page URL |
| `--output` | `./web-articles` | Output directory |
| `--download-images` | `true` | Download article images locally |
| `--wait` | `3` | Seconds to wait after navigation |

## Notes

- `web read` is intentionally generic: it uses DOM heuristics instead of a site-specific parser.
- For sites that already have a dedicated adapter such as `weixin download` or `zhihu download`, prefer the site-specific command when you need stronger extraction quality.
