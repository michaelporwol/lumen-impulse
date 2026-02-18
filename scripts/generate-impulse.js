#!/usr/bin/env node

/**
 * Daily impulse generator for Lumen.
 *
 * 1. Fetches today's Gospel reference from USCCB
 * 2. Fetches actual Bible text from Bolls.life (public domain, no API key needed)
 * 3. Calls Magisterium AI API for each language (de, en, pl)
 * 4. Writes JSON to impulses/<date>.json + impulses/latest.json
 *
 * NO user data is ever sent to any API — only the Gospel reference.
 * Bible texts are PUBLIC DOMAIN (Elberfelder 1871, KJV, Biblia Gdańska 1881).
 * Only the Magisterium API key is needed (MAGISTERIUM_API_KEY env var).
 */

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────
const MAGISTERIUM_API_URL = 'https://www.magisterium.com/api/v1/chat/completions';
const API_KEY = process.env.MAGISTERIUM_API_KEY;
const BOLLS_API_BASE = 'https://bolls.life';
const LANGUAGES = ['de', 'en', 'pl'];
const API_TIMEOUT_MS = 30000; // 30s timeout (CI has no rush)

// Bible versions on Bolls.life — ALL public domain, no copyright issues
const BOLLS_VERSIONS = {
  de: { id: 'ELB', name: 'Elberfelder 1871' },
  en: { id: 'KJV', name: 'King James Version' },
  pl: { id: 'BG', name: 'Biblia Gdańska 1881' },
};

// ── USCCB Gospel Parser ────────────────────────────────────────────

const bibleBookGermanMap = {
  matthew: 'Matthaeus', mark: 'Markus', luke: 'Lukas', john: 'Johannes',
  mt: 'Matthaeus', mk: 'Markus', lk: 'Lukas', jn: 'Johannes',
  matt: 'Matthaeus', mrk: 'Markus', luk: 'Lukas', joh: 'Johannes',
};

function getLocalIsoDate() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(new Date());
}

function toUsccbDateSlug(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${month}${day}${year.slice(-2)}`;
}

function toGermanDisplayReference(reference) {
  const normalized = reference.replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^([1-3]?\s?[A-Za-z.]+)\s+([0-9].*)$/);
  if (!match) return normalized;
  const bookRaw = match[1].replace(/\./g, '').trim();
  const chapterVerse = match[2].replace(/:/g, ',');
  const germanBook = bibleBookGermanMap[bookRaw.toLowerCase()] || bookRaw;
  return `${germanBook} ${chapterVerse}`;
}

function parseUsccbMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  let title = '';
  let reference = '';

  for (const line of lines) {
    if (!line.startsWith('## ')) continue;
    const candidate = line.slice(3).trim();
    if (!candidate) continue;
    if (/^Get the Daily Readings/i.test(candidate)) continue;
    title = candidate;
    break;
  }

  let isInGospelSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^###\s+Gospel\b/i.test(line)) {
      isInGospelSection = true;
      continue;
    }
    if (isInGospelSection && /^###\s+/.test(line)) break;
    if (!isInGospelSection) continue;
    const referenceMatch = line.match(/\[([^\]]+)\]\(/);
    if (referenceMatch) {
      reference = referenceMatch[1].trim();
      break;
    }
  }

  return { title, reference };
}

async function fetchGospelReference(isoDate) {
  const slug = toUsccbDateSlug(isoDate);
  const url = `https://bible.usccb.org/bible/readings/${slug}.cfm.md`;

  console.log(`Fetching USCCB: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`USCCB fetch failed: ${resp.status}`);

  const markdown = await resp.text();
  const { title, reference } = parseUsccbMarkdown(markdown);

  if (!reference) {
    throw new Error('Could not find Gospel reference in USCCB response');
  }

  return {
    reference,
    referenceDisplay: toGermanDisplayReference(reference),
    title: title || 'Daily Gospel',
  };
}

// ── Bolls.life — Fetch Bible text (public domain, no API key) ─────

/**
 * Map English book names (from USCCB) to Bolls.life book numbers.
 * Bolls.life uses sequential numbering: Genesis=1 ... Revelation=66.
 * Includes Catholic deuterocanonical books and common USCCB name variants.
 */
const BOOK_TO_NUMBER = {
  'genesis': 1, 'exodus': 2, 'leviticus': 3, 'numbers': 4,
  'deuteronomy': 5, 'joshua': 6, 'judges': 7, 'ruth': 8,
  '1 samuel': 9, '2 samuel': 10, '1 kings': 11, '2 kings': 12,
  '1 chronicles': 13, '2 chronicles': 14, 'ezra': 15, 'nehemiah': 16,
  'esther': 17, 'job': 18, 'psalms': 19, 'psalm': 19, 'proverbs': 20,
  'ecclesiastes': 21, 'song of solomon': 22, 'song of songs': 22,
  'isaiah': 23, 'jeremiah': 24, 'lamentations': 25,
  'ezekiel': 26, 'daniel': 27,
  'hosea': 28, 'joel': 29, 'amos': 30, 'obadiah': 31,
  'jonah': 32, 'micah': 33, 'nahum': 34, 'habakkuk': 35,
  'zephaniah': 36, 'haggai': 37, 'zechariah': 38, 'malachi': 39,
  'matthew': 40, 'matt': 40, 'mt': 40,
  'mark': 41, 'mk': 41, 'mrk': 41,
  'luke': 42, 'lk': 42, 'luk': 42,
  'john': 43, 'jn': 43, 'joh': 43,
  'acts': 44, 'romans': 45, '1 corinthians': 46, '2 corinthians': 47,
  'galatians': 48, 'ephesians': 49, 'philippians': 50, 'colossians': 51,
  '1 thessalonians': 52, '2 thessalonians': 53,
  '1 timothy': 54, '2 timothy': 55, 'titus': 56, 'philemon': 57,
  'hebrews': 58, 'james': 59,
  '1 peter': 60, '2 peter': 61,
  '1 john': 62, '2 john': 63, '3 john': 64,
  'jude': 65, 'revelation': 66,
};

/**
 * Parse a USCCB-style reference like "Mark 8:11-13", "1 John 3:1-2",
 * or multi-range "Matthew 6:1-6, 16-18" into a result with verse ranges.
 * Returns { bookNumber, chapter, ranges: [{ verseStart, verseEnd }] }
 * Also sets verseStart/verseEnd spanning the full range for backwards compat.
 */
function parseReference(reference) {
  const normalized = reference.replace(/\s+/g, ' ').trim();

  // Match: optional number prefix, book name, chapter:verses (including multi-range like "6:1-6, 16-18")
  const match = normalized.match(/^([1-3]?\s?[A-Za-z]+(?:\s+of\s+[A-Za-z]+)?)\s+(\d+):(.+)$/);
  if (!match) {
    console.warn(`  ⚠️ Could not parse reference: "${reference}"`);
    return null;
  }

  const bookRaw = match[1].trim().toLowerCase();
  const chapter = parseInt(match[2], 10);
  const versePart = match[3].trim();

  const bookNumber = BOOK_TO_NUMBER[bookRaw];
  if (!bookNumber) {
    console.warn(`  ⚠️ Unknown book: "${bookRaw}"`);
    return null;
  }

  // Parse verse ranges: "1-6, 16-18" → [{1,6}, {16,18}]
  const ranges = [];
  for (const segment of versePart.split(/[,;]\s*/)) {
    const rangeMatch = segment.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
      ranges.push({ verseStart: start, verseEnd: end });
    }
  }

  if (ranges.length === 0) {
    console.warn(`  ⚠️ Could not parse verses: "${versePart}"`);
    return null;
  }

  return {
    bookNumber,
    chapter,
    verseStart: ranges[0].verseStart,
    verseEnd: ranges[ranges.length - 1].verseEnd,
    ranges,
  };
}

/**
 * Fetch Bible text for a single language, supporting multi-range references.
 * Fetches the full chapter once and filters by all verse ranges.
 */
async function fetchBibleTextMultiRange(translation, bookNumber, chapter, ranges, lang) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${BOLLS_API_BASE}/get-text/${translation}/${bookNumber}/${chapter}/`;
    const rangeStr = ranges.map(r => `${r.verseStart}-${r.verseEnd}`).join(', ');
    console.log(`  📖 Fetching Bolls.life [${lang}]: ${translation} book=${bookNumber} ch=${chapter} v${rangeStr}...`);

    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`  ⚠️ Bolls.life [${lang}] ${resp.status}: ${body.substring(0, 200)}`);
      return null;
    }

    const verses = await resp.json();
    if (!Array.isArray(verses) || verses.length === 0) {
      console.warn(`  ⚠️ Bolls.life [${lang}]: No verses returned`);
      return null;
    }

    // Filter to all requested verse ranges
    const filtered = verses.filter((v) =>
      ranges.some(r => v.verse >= r.verseStart && v.verse <= r.verseEnd)
    );
    if (filtered.length === 0) {
      console.warn(`  ⚠️ Bolls.life [${lang}]: No verses in requested ranges`);
      return null;
    }

    const text = filtered
      .map((v) => v.text
        .replace(/<S>\d+<\/S>/gi, '')
        .replace(/<[^>]*>/g, '')
        .trim()
      )
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const versionName = BOLLS_VERSIONS[lang]?.name || translation;
    console.log(`  ✅ Bolls.life [${lang}] (${versionName}): ${text.substring(0, 80)}...`);
    return { text, reference: versionName };
  } catch (err) {
    console.warn(`  ⚠️ Bolls.life [${lang}] error:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch Bible text for all languages from Bolls.life.
 * Returns { de, en, pl } with { text, reference } per language, or null on total failure.
 * No API key needed — all public domain translations.
 */
async function fetchAllBibleTexts(reference) {
  const parsed = parseReference(reference);
  if (!parsed) {
    console.warn('  ⚠️ Skipping Bible text fetch — could not parse reference');
    return null;
  }

  const { bookNumber, chapter, ranges } = parsed;
  const rangeStr = ranges.map(r => `${r.verseStart}-${r.verseEnd}`).join(', ');
  console.log(`\n📖 Fetching Bible text: book=${bookNumber} ch=${chapter} v${rangeStr}\n`);

  const results = {};
  for (const lang of LANGUAGES) {
    const version = BOLLS_VERSIONS[lang];
    if (!version) continue;
    results[lang] = await fetchBibleTextMultiRange(version.id, bookNumber, chapter, ranges, lang);
  }

  // At least one language must succeed
  const successCount = Object.values(results).filter(Boolean).length;
  if (successCount === 0) return null;

  return results;
}

// ── Magisterium AI API ─────────────────────────────────────────────

function buildPrompt(gospelRef, lang) {
  const langLabel = lang === 'de' ? 'Deutsch' : lang === 'pl' ? 'Polnisch' : 'Englisch';
  const langDu = lang === 'de' ? 'Duze den Leser' : lang === 'pl' ? 'Zwracaj się per "ty"' : 'Use "you" (informal)';

  return {
    system: `Du bist ein katholischer geistlicher Begleiter in der ignatianischen Tradition. Antworte ausschließlich mit validem JSON. Kein Markdown, keine Codeblöcke, kein umschließender Text – nur das reine JSON-Objekt.`,
    user: `Das heutige Tagesevangelium: ${gospelRef}

Erstelle einen universellen Morgenimpuls auf ${langLabel} als JSON:
{"impuls":{"title":"...","text":"..."},"mitnahme":{"title":"${lang === 'de' ? 'Eine Frage für heute' : lang === 'pl' ? 'Pytanie na dziś' : 'A question for today'}","text":"..."},"tieferReingehen":{"titel":"...","text":"...","gedanken":["...","...","..."],"uebung":"..."}}

Regeln:
- ${langDu}
- 2-3 Sätze pro Impuls-Text, lebensnah und warm
- Die Frage (mitnahme) soll konkret und alltagstauglich sein
- tieferReingehen: theologisch fundiert (Kirchenväter, Ignatius, KKK), 3 Gedanken, 1 praktische Übung
- Kein Moralisieren, keine Angst-Rhetorik, ignatianisch-barmherzig
- Beziehe dich auf das Tagesevangelium`,
  };
}

function parseImpulseJson(content) {
  let cleaned = content.trim();

  // Strip markdown code fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find the outermost JSON object
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(cleaned);

  // Validate required fields
  if (!parsed.impuls?.title || !parsed.impuls?.text) {
    throw new Error('Missing impuls.title or impuls.text');
  }
  if (!parsed.mitnahme?.text) {
    throw new Error('Missing mitnahme.text');
  }
  if (!parsed.tieferReingehen?.titel || !parsed.tieferReingehen?.text) {
    throw new Error('Missing tieferReingehen fields');
  }
  if (!Array.isArray(parsed.tieferReingehen.gedanken)) {
    parsed.tieferReingehen.gedanken = [parsed.tieferReingehen.gedanken || ''];
  }

  return {
    impuls: { title: parsed.impuls.title, text: parsed.impuls.text },
    mitnahme: {
      title: parsed.mitnahme.title || 'Eine Frage für heute',
      text: parsed.mitnahme.text,
    },
    tieferReingehen: {
      titel: parsed.tieferReingehen.titel,
      text: parsed.tieferReingehen.text,
      gedanken: parsed.tieferReingehen.gedanken,
      uebung: parsed.tieferReingehen.uebung || '',
    },
  };
}

async function callMagisterium(gospelRef, lang) {
  const { system, user } = buildPrompt(gospelRef, lang);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    console.log(`  Calling Magisterium API for lang=${lang}...`);
    const resp = await fetch(MAGISTERIUM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Magisterium API ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from Magisterium API');

    const impulse = parseImpulseJson(content);
    console.log(`  ✅ ${lang}: "${impulse.impuls.title}"`);
    return impulse;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('❌ MAGISTERIUM_API_KEY environment variable is not set');
    process.exit(1);
  }

  const today = getLocalIsoDate();
  console.log(`\n📅 Generating impulse for ${today}\n`);

  // 1. Fetch Gospel reference
  let gospel;
  try {
    gospel = await fetchGospelReference(today);
    console.log(`📖 Gospel: ${gospel.referenceDisplay} (${gospel.reference})\n`);
  } catch (err) {
    console.error('❌ Failed to fetch Gospel reference:', err.message);
    process.exit(1);
  }

  // 2. Fetch Bible text (Bolls.life, public domain, no API key needed)
  //    Non-critical — continues even if it fails
  let gospelTexts = null;
  try {
    gospelTexts = await fetchAllBibleTexts(gospel.reference);
  } catch (err) {
    console.warn('⚠️ Bible text fetch failed (non-critical):', err.message);
  }

  // 3. Generate impulses for all languages (Magisterium AI)
  const impulses = {};
  for (const lang of LANGUAGES) {
    try {
      impulses[lang] = await callMagisterium(gospel.referenceDisplay, lang);
    } catch (err) {
      console.error(`❌ Failed for ${lang}:`, err.message);
      // Don't fail the whole run — partial results are better than none
      impulses[lang] = null;
    }
  }

  // Check that at least one language succeeded
  const successCount = Object.values(impulses).filter(Boolean).length;
  if (successCount === 0) {
    console.error('❌ All API calls failed. No impulse generated.');
    process.exit(1);
  }

  // 4. Write JSON files
  const output = {
    date: today,
    gospelRef: gospel.referenceDisplay,
    gospelRefOriginal: gospel.reference,
    generatedAt: new Date().toISOString(),
    gospelTexts: gospelTexts || null,
    impulses,
  };

  const impulsesDir = path.join(__dirname, '..', 'impulses');
  fs.mkdirSync(impulsesDir, { recursive: true });

  const datePath = path.join(impulsesDir, `${today}.json`);
  const latestPath = path.join(impulsesDir, 'latest.json');
  const jsonStr = JSON.stringify(output, null, 2);

  fs.writeFileSync(datePath, jsonStr, 'utf-8');
  fs.writeFileSync(latestPath, jsonStr, 'utf-8');

  console.log(`\n✅ Written: impulses/${today}.json`);
  console.log(`✅ Written: impulses/latest.json`);
  console.log(`✅ ${successCount}/${LANGUAGES.length} languages generated successfully\n`);
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
