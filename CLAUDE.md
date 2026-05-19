# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MentiSystema (mentisystema.org) is a personal research portfolio and lab site focused on behavioral AI, signal intelligence, and adversarial research. It is a **pure static HTML/CSS/JS site** — no build system, no package manager, no bundler. Files are served directly and deployed via GitHub Pages.

## Development

No build step required. Open HTML files directly in a browser or use any static file server:

```bash
python3 -m http.server 8080
# or
npx serve .
```

There are no tests, no linting configuration, and no CI pipeline.

## Architecture

### Two Page Patterns

Pages follow one of two patterns:

1. **Shared stylesheet pages** (`phreaker-box.html`, `dendra-a-eye.html`): Link to `styles.css`. Simple layout using `.site-shell`, `.top-nav`, and basic typography. Intended for stub/WIP project pages.

2. **Self-contained pages** (`index.html`, `ai-timeline.html`, `friction-bloom.html`, `vector-llm.html`, `100-prisoners.html`, `ctf/index.html`): All CSS is inlined in `<style>` tags in the `<head>`. These pages do not use `styles.css`. They include their own nav, background layers, and typography setup.

When creating or editing a page, match the pattern already used by that file.

### React Usage (No Build Step)

Interactive pages load React 18 and Babel standalone from CDN and define components inline:

```html
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel">
  const { useState, useEffect } = React;
  // component code here
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<MyComponent />);
</script>
```

Babel parse errors have caused repeated breakage historically (see git log). Avoid special Unicode characters, ligatures, and curly quotes inside `<script type="text/babel">` blocks — use straight quotes only.

### Design System

All self-contained pages define the same CSS tokens in `:root`:

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#070b0f` | Page background |
| `--teal` | `#00e0b8` | Primary accent, nav active state, headings |
| `--purple` | `#9b5cff` | Secondary accent |
| `--text` | `#e5e7eb` | Body text |
| `--muted` | `#a8b3c2` | Subdued text |
| `--dim` | `#4a5568` | De-emphasized labels |
| `--line` | `rgba(255,255,255,0.08)` | Borders and dividers |

**Fonts** (loaded from Google Fonts):
- `Rajdhani` — Display headings, nav logo, section titles
- `Space Mono` — Monospace labels, eyebrows, UI chips, technical text
- `Inter` — Body prose

**Background decoration** pattern (used consistently across self-contained pages):
- Fixed grid overlay: `linear-gradient` on both axes at 52px intervals
- Radial glow: teal at top-center, purple at bottom-right, both subtle opacity

**Nav** is fixed, 64px tall, with `backdrop-filter: blur(12px)`. Logo links to `/`. Active nav links use `color: var(--teal)`.

**Content container**: `.shell { width: min(1120px, 90%); margin: 0 auto; }` (or `.site-shell` on older pages using `styles.css`).

**Scrollbar**: Always styled to 3px width with a teal or project-accent-colored thumb.

### Project-Specific Accent Colors

Each project page uses its own accent alongside teal:
- Friction Bloom: `--green: #78ff50`
- VectorLLM: `--green: #78ff50`
- 100 Prisoners: `--amber: #f0a832`
- CTF (CTRL-RUPTURE): `#CC0000` red on white background (inverted theme)

### Passphrase Gates

Two pages include client-side passphrase gates (plaintext checks in source):
- `ctf/index.html`: checks for `CTRL-RUPTURE`
- `projects/vector-llm.html`: gated section with its own passphrase input

These are intentional — not security vulnerabilities to fix.

## Deployment

Deployed to GitHub Pages. The `CNAME` file contains `mentisystema.org`. Pushing to `main` triggers deployment automatically.
