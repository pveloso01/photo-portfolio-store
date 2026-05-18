# photo-portfolio-store

A photographer's portfolio and print storefront. Showcases event coverage, sells prints and digital downloads, and links out to externally hosted client galleries.

## Goals

- Present a curated body of work with strong visual hierarchy
- Sell prints, digital downloads, and licensed images
- Surface event coverage and editorial work hosted on third-party sites without leaking visitors
- Earn the visual quality bar of a real photography brand, not a template

## Status

Early planning. No code committed yet. Direction, stack, and information architecture are being defined.

## Planned sections

- **Home** — hero work, positioning, primary CTA
- **Selected Work / Events** — curated event coverage with on-site previews and outbound links to full client galleries
- **Shop** — prints and digital products with size, framing, and edition options
- **About** — photographer bio, approach, clients
- **Press / Featured In** — credentials and publication logos
- **Contact** — booking and inquiries

## Stack

To be decided. Candidates under evaluation:

- Next.js + Tailwind + a headless CMS (Sanity / Payload) + Stripe
- Astro + Shopify Hydrogen
- A photographer-focused platform (Pic-Time, Format, Squarespace) if custom build is overkill

## References

Inspiration sources tracked separately. See `docs/inspiration.md` (TBD).

## Local development

Boot the local infrastructure stack (Postgres, Redis, MinIO, Qdrant, Mailpit):

```bash
docker compose -f docker-compose.dev.yml up -d
```

See [`docs/local-dev.md`](docs/local-dev.md) for prerequisites, env setup, service verification, and app boot commands.

## License

TBD.
