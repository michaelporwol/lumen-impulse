# Lumen Impulse

> **The daily Catholic gospel reading in six languages — fetched automatically every night, served as static JSON. No AI.**

This repository powers the morning impulses inside [Lumen](https://lumenexamen.com), a Catholic Ignatian examen app. Every day at 00:01 CET, a GitHub Actions workflow looks up the day's gospel reference and retrieves the actual scripture text from public-domain Bible translations — in German, English, Polish, Spanish, Italian and French.

**No AI is involved.** Until 1 June 2026 the workflow also asked Magisterium AI for a short reflection; that step was removed. What ships today is the gospel text itself and nothing else. This matches Lumen's own principle: no cloud, no account, no AI in prayer.

The output is plain JSON. No backend. No database. No tracking. Just static files on GitHub Pages that any client can fetch over HTTPS.

**Live status dashboard:** [michaelporwol.github.io/lumen-impulse/status.html](https://michaelporwol.github.io/lumen-impulse/status.html)
**Today's impulse:** [`impulses/latest.json`](https://michaelporwol.github.io/lumen-impulse/impulses/latest.json)

---

## Why this exists

Most "daily devotional" apps either lock content behind a paywall, ship it bundled with the app (so it never updates), or phone home to a proprietary backend. None of those fit a privacy-first Catholic prayer app.

Lumen Impulse takes the opposite approach:

- **Public**. Every file ever generated is in this repo. Anyone can read, fork, audit, or use it.
- **Static**. Just JSON files served by GitHub Pages. No server to maintain, no database to migrate, no API key to rotate.
- **No AI, no interpretation.** Since 1 June 2026 the pipeline ships scripture only — the gospel of the day, nothing added. What the reader gets is the text the Church reads that day, not a machine's paraphrase of it.
- **Six languages**. German (Elberfelder 1871), English (King James Version), Polish (Biblia Gdańska 1881), Spanish (Reina-Valera 1909), Italian (Riveduta 1927) and French (Augustin Crampon 1923) — all public domain. Spanish, Italian and French come from gospel text files kept in this repo, because Bolls.life offers only copyrighted editions for those languages.
- **Auditable**. The generator is plain Node.js in [`scripts/generate-impulse.js`](./scripts/generate-impulse.js). No hidden logic, no model, no API key for content.

If you're building anything in the same space — a Catholic app, a parish website, a Liturgy of the Hours plugin — feel free to read the JSON directly, fork the generator, or copy the architecture.

---

## What's in the JSON

Every day a file named `impulses/YYYY-MM-DD.json` is committed, and `impulses/latest.json` is updated to point to the same content. Schema:

```json
{
  "date": "2026-05-10",
  "gospelRef": "Johannes 14,15-21",
  "gospelRefOriginal": "John 14:15-21",
  "gospelRefs": {
    "de": "Johannes 14,15-21",
    "en": "John 14,15-21",
    "pl": "Jan 14,15-21"
  },
  "generatedAt": "2026-05-10T00:03:14.221Z",
  "gospelTexts": {
    "de": { "text": "...", "reference": "Elberfelder 1871" },
    "en": { "text": "...", "reference": "King James Version" },
    "pl": { "text": "...", "reference": "Biblia Gdańska 1881" }
  },
  "impulses": {
    "de": {
      "impuls":     { "title": "...", "text": "..." },
      "mitnahme":   { "title": "Eine Frage für heute", "text": "..." },
      "tieferReingehen": {
        "titel": "...",
        "text": "...",
        "gedanken": ["...", "...", "..."],
        "uebung": "..."
      }
    },
    "en": { "impuls": {...}, "mitnahme": {...}, "tieferReingehen": {...} },
    "pl": { "impuls": {...}, "mitnahme": {...}, "tieferReingehen": {...} }
  }
}
```

Field guide:

| Field | Purpose |
|-------|---------|
| `date` | The day this file belongs to (`YYYY-MM-DD`, Europe/Berlin). |
| `gospelRef` / `gospelRefOriginal` | The gospel reference of the day, as resolved and as originally returned. |
| `gospelRefs` | The same reference with localised book names, one per language. |
| `gospelTexts` | Per language: `text` (the gospel passage) and `reference` (which public-domain translation it came from). |
| `generatedAt` | ISO timestamp of the run that wrote the file. |

**Note (June 2026):** earlier files also carried `impuls`, `mitnahme` and `tieferReingehen` — the AI-written reflection. Those fields are gone from new files. Clients must treat them as optional.

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
   00:01 CET        │  GitHub Actions: generate.yml               │
   (cron)           │  └─ scripts/generate-impulse.js             │
                    └────────────────────┬────────────────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
    ┌─────────────────┐         ┌─────────────────┐       ┌─────────────────┐
    │  Evangelizo     │         │  Bolls.life     │       │  bibles/*.json  │
    │  (gospel ref)   │         │  (de / en / pl) │       │  (es / it / fr) │
    │  USCCB fallback │         │  ELB / KJV / BG │       │  public domain  │
    └─────────────────┘         └─────────────────┘       └─────────────────┘
                                         │
                                         ▼
                        ┌─────────────────────────────────┐
                        │  impulses/YYYY-MM-DD.json       │
                        │  impulses/latest.json           │
                        └────────────────┬────────────────┘
                                         │ git push
                                         ▼
                        ┌─────────────────────────────────┐
                        │  GitHub Pages (HTTPS, static)   │
                        │  michaelporwol.github.io/       │
                        │     lumen-impulse/impulses/...  │
                        └────────────────┬────────────────┘
                                         │ HTTPS fetch
                                         ▼
                        ┌─────────────────────────────────┐
                        │  Lumen app / your client        │
                        └─────────────────────────────────┘
```

### Data sources

- **Gospel reference** — [Evangelizo](https://feed.evangelizo.org) is queried first; if it fails, we fall back to [USCCB](https://bible.usccb.org) markdown parsing.
- **Bible text** — [Bolls.life](https://bolls.life) public API. All translations used are public domain:
  - German: **Elberfelder 1871** (ELB)
  - English: **King James Version** (KJV)
  - Polish: **Biblia Gdańska 1881** (BG)
- **Reflection** — removed on 1 June 2026. The pipeline no longer calls any language model; there is no prompt and no API key for content.

### Resilience

- **Two scheduled runs per day** (00:01 and 04:30 UTC) so a single GitHub outage doesn't skip a day. The second run no-ops if the day's file already exists.
- **External monitoring** — a separate cron on the host machine runs `lumen-impulse-check` at 06:00 CET; if the JSON for the day is missing it triggers the workflow via `workflow_dispatch`.
- **Per-language failure isolation** — if one language fails to generate, the other two still ship. The result is a partial file (`null` entries are honored by clients) rather than no file at all.
- **Footnote stripping** — the public-domain editions carry footnote markers (KJV puts every footnote in `<sup>`); these are stripped before the JSON is written.
- **Keep-alive workflow** — GitHub disables scheduled workflows after 60 days of repo inactivity. A second workflow runs twice a month to keep this one armed.

### Audio (optional sidecar)

A separate cron job on the Lumen author's machine generates audio narrations of each day's gospel in all six languages using Microsoft `edge-tts` and uploads them to a CDN. The status manifest is committed back to this repo under `audio-status/YYYY-MM-DD.json` so the [status dashboard](https://michaelporwol.github.io/lumen-impulse/status.html) can verify audio availability over HTTPS without mixed-content issues. The audio files themselves are not in this repo.

---

## Running it yourself

If you want to fork this and generate impulses for your own app, parish, or project:

```bash
git clone https://github.com/michaelporwol/lumen-impulse.git
cd lumen-impulse
export MAGISTERIUM_API_KEY="your-key-from-magisterium.com"
node scripts/generate-impulse.js
```

The script writes `impulses/<today>.json` and `impulses/latest.json`. No other dependencies — Node 20+ is enough.

To run it on a schedule, copy `.github/workflows/generate.yml`, add `MAGISTERIUM_API_KEY` to your fork's repo secrets, and enable GitHub Pages on the `main` branch root. That's the entire setup.

### Adapting the prompt

The prompt lives in [`scripts/generate-impulse.js`](./scripts/generate-impulse.js), function `buildPrompt`. It deliberately:

- Asks for warm, life-near, Ignatian language
- Forbids moralism and fear-rhetoric
- Forbids cross-language Bible quotations (no English verses in the German text — a real bug we hit early)
- Forbids footnote markers
- Targets ~2–3 sentences for the headline reflection and longer theological depth in `tieferReingehen`

Adapt freely — but if you change the prompt structure, also update the validator in `parseImpulseJson()`.

### Adding a fourth language

1. Add the language code to the `LANGUAGES` array.
2. Add a public-domain Bible translation ID to `BOLLS_VERSIONS` (browse [bolls.life translations](https://bolls.life/api/) for available IDs).
3. Add the bible book name map for that language to `bibleBookMaps`.
4. Update the prompt's `langLabel` and `langDu` switches.
5. Add the key (`mitnahme.title`, `tieferReingehen` labels, etc.) to `parseImpulseJson` and `clean_for_tts` in any audio generator.

---

## Privacy

No user data is ever transmitted. The generator only sends:

- The day's gospel reference (e.g. `John 14:15-21`) to the Bible sources
- The translation IDs and verse range to Bolls.life

Both are public information. Your readers' identities, prayer history, and journal entries — none of that exists here.

When the Lumen app fetches `latest.json`, it does so as an anonymous GET request from the user's device. GitHub Pages logs that request server-side per its standard policy (see [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)), but no Lumen-specific identifier is attached.

---

## Theological notes

- What ships is **scripture, not commentary**. Since 1 June 2026 the pipeline adds nothing to the gospel of the day — no reflection, no interpretation, no machine paraphrase. That removes the question of doctrinal authority instead of answering it.
- The translations are **public domain**, which is why they are old (Elberfelder 1871, KJV, Biblia Gdańska 1881, Reina-Valera 1909, Riveduta 1927, Crampon 1923). They are not the editions read aloud in today's liturgy; they carry the same passage in a legally reusable form.
- The readings follow the **Roman Rite** lectionary as used by the USCCB and the Catholic Church in Germany. They will not align with the Tridentine calendar, and the Ambrosian Rite of Milan differs on some days.
- Historical note: files generated before 1 June 2026 contain an AI-written reflection (Magisterium AI). Those files are kept for the record. They were never magisterial and should be read as meditation prompts, not teaching.

---

## Status & monitoring

- **Live dashboard**: [status.html](https://michaelporwol.github.io/lumen-impulse/status.html) shows the last 30 days at a glance — JSON availability, gospel text per language, and audio per language.
- **Workflow runs**: [Actions tab](../../actions) on GitHub.
- **Issue tracker**: this repo's [Issues](../../issues) for bugs and requests.

---

## License

The **code** in `scripts/` and `.github/workflows/` is released under the MIT License — see [LICENSE](./LICENSE).

The **generated reflections** in `impulses/` are released under [Creative Commons Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Use them in your app, parish bulletin, or website — please credit "Lumen Impulse — lumenexamen.com" with a link.

The **scripture quotations** are public domain (Elberfelder 1871, KJV, Biblia Gdańska 1881) and are governed by their original public-domain status, not by this repository's license.

The **app** that uses these impulses, [Lumen](https://lumenexamen.com), is a separate proprietary work and is not covered by this license.

---

## About Lumen

[Lumen](https://lumenexamen.com) is a Catholic daily examen app for iPhone, iPad, and Android. It walks you through the seven-step Ignatian examination of conscience each evening, helps you prepare for confession, and stays entirely on your device — no cloud sync, no backend, no tracking. The morning impulses generated by this repository are read aloud or displayed as the day begins.

Built with care for the glory of God.

— [lumenexamen.com](https://lumenexamen.com)
