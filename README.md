# Vera — ZOE Women in Tech Hackathon

A claim-vs-evidence checker for supplement marketing, built for the ZOE Women in Tech Hackathon (July 2026).

**Problem statement:** How might we help people evaluate health claims, products, and advice in a way that is accessible, trustworthy, and grounded in evidence?

**Who it's for:** Women under 35 who buy supplements (creatine, collagen, greens) based on social media creator content rather than ingredient research.

**What it does:**
- Paste a TikTok/Instagram post (or try a trending example) and see the creator's credibility flags (medical credential, sponsorship disclosure)
- See each marketing claim scored against real evidence, with sources
- See what real reviewers experienced, not just the marketing

## Running it

No build step, no dependencies. Just open `index.html` in any browser, or host it as a static site (GitHub Pages, Netlify, etc.).

## Editing

All product/post/review data lives in the `PRODUCTS` object near the top of the `<script>` in `index.html`. Add a new entry there to add another product to the demo.

## Status

Prototype only — not connected to any real data source, social platform, or backend. Built as a hackathon demo.
