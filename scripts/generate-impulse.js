#!/usr/bin/env node

/**
 * Daily impulse generator for Lumen.
 *
 * 1. Fetches today's Gospel reference from USCCB
 * 2. Fetches actual Bible text from API.Bible for DE/EN/PL
 * 3. Calls Magisterium AI API for each language (de, en, pl)
 * 4. Writes JSON to impulses/<date>.json + impulses/latest.json
 *
 * NO user data is ever sent to any API — only the Gospel reference.
 * API keys come from environment variables (MAGISTERIUM_API_KEY, API_BIBLE_KEY).
 */

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────
const MAGISTERIUM_API_URL = 'https://www.magisterium.com/api/v1/chat/completions';
const API_KEY = process.env.MAGISTERIUM_API_KEY;
const API_BIBLE_KEY = process.env.API_BIBLE_KEY;
const API_BIBLE_BASE = 'https://api.scripture.api.bible/v1';
const LANGUAGES = ['de', 'en', 'pl'];
const API_TIMEOUT_MS = 30000; // 30s timeout (CI has no rush)

// Bible version IDs for API.Bible (per language)
// To find IDs: GET https://api.scripture.api.bible/v1/bibles?language=deu (or eng, pol)
// User specified DE ID. EN/PL will be verified on first run — if they fail,
// update the IDs here. The script continues even if Bible text fetch fails.
const BIBLE_VERSIONS = {
  de: 'f492a38d0e52db0f-01', // Elberfelder Translation (bibelkommentare.de) — user-specified
  en: 'de4e12af7f28f599-02', // King James (Authorised) Version
  pl: '18c05e3bd0440626-01', // Biblia Gdańska (public domain)
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

// ── API.Bible — Fetch actual Bible text ───────────────────────────

/**
 * Map English book names (from USCCB) to OSIS book abbreviations (API.Bible format).
 * Covers all Gospel books + common lectionary books.
 */
const BOOK_TO_OSIS = {
  'genesis': 'GEN', 'exodus': 'EXO', 'leviticus': 'LEV', 'numbers': 'NUM',
  'deuteronomy': 'DEU', 'joshua': 'JOS', 'judges': 'JDG', 'ruth': 'RUT',
  '1 samuel': '1SA', '2 samuel': '2SA', '1 kings': '1KI', '2 kings': '2KI',
  '1 chronicles': '1CH', '2 chronicles': '2CH', 'ezra': 'EZR', 'nehemiah': 'NEH',
  'tobit': 'TOB', 'judith': 'JDT', 'esther': 'EST',
  '1 maccabees': '1MA', '2 maccabees': '2MA',
  'job': 'JOB', 'psalms': 'PSA', 'psalm': 'PSA', 'proverbs': 'PRO',
  'ecclesiastes': 'ECC', 'song of solomon': 'SNG', 'song of songs': 'SNG',
  'wisdom': 'WIS', 'sirach': 'SIR', 'ecclesiasticus': 'SIR',
  'isaiah': 'ISA', 'jeremiah': 'JER', 'lamentations': 'LAM',
  'baruch': 'BAR', 'ezekiel': 'EZK', 'daniel': 'DAN',
  'hosea': 'HOS', 'joel': 'JOL', 'amos': 'AMO', 'obadiah': 'OBA',
  'jonah': 'JON', 'micah': 'MIC', 'nahum': 'NAM', 'habakkuk': 'HAB',
  'zephaniah': 'ZEP', 'haggai': 'HAG', 'zechariah': 'ZEC', 'malachi': 'MAL',
  'matthew': 'MAT', 'matt': 'MAT', 'mt': 'MAT',
  'mark': 'MRK', 'mk': 'MRK', 'mrk': 'MRK',
  'luke': 'LUK', 'lk': 'LUK', 'luk': 'LUK',
  'john': 'JHN', 'jn': 'JHN', 'joh': 'JHN',
  'acts': 'ACT', 'romans': 'ROM', '1 corinthians': '1CO', '2 corinthians': '2CO',
  'galatians': 'GAL', 'ephesians': 'EPH', 'philippians': 'PHP', 'colossians': 'COL',
  '1 thessalonians': '1TH', '2 thessalonians': '2TH',
  '1 timothy': '1TI', '2 timothy': '2TI', 'titus': 'TIT', 'philemon': 'PHM',
  'hebrews': 'HEB', 'james': 'JAS',
  '1 peter': '1PE', '2 peter': '2PE',
  '1 john': '1JN', '2 john': '2JN', '3 john': '3JN',
  'jude': 'JUD', 'revelation': 'REV',
};

/**
 * Convert a USCCB-style reference like "Mark 8:11-13" or "1 John 3:1-2"
 * into API.Bible OSIS passageId like "MRK.8.11-MRK.8.13"
 */
function referenceToOsis(reference) {
  const normalized = reference.replace(/\s+/g, ' ').trim();

  // Match: optional number prefix, book name, chapter:verse(-verse)
  const match = normalized.match(/^([1-3]?\s?[A-Za-z]+(?:\s+of\s+[A-Za-z]+)?)\s+(\d+):(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (!match) {
    console.warn(`  ⚠️ Could not parse reference: "${reference}"`);
    return null;
  }

  const bookRaw = match[1].trim().toLowerCase();
  const chapter = match[2];
  const verseStart = match[3];
  const verseEnd = match[4] || verseStart;

  const osisBook = BOOK_TO_OSIS[bookRaw];
  if (!osisBook) {
    console.warn(`  ⚠️ Unknown book: "${bookRaw}"`);
    return null;
  }

  if (verseStart === verseEnd) {
    return `${osisBook}.${chapter}.${verseStart}`;
  }
  return `${osisBook}.${chapter}.${verseStart}-${osisBook}.${chapter}.${verseEnd}`;
}

/**
 * Fetch Bible text from API.Bible for a given passage and Bible version.
 * Returns { text, copyright, fums } or null on failure.
 */
async function fetchBibleText(bibleId, passageId, lang) {
  if (!API_BIBLE_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${API_BIBLE_BASE}/bibles/${bibleId}/passages/${passageId}?content-type=text&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-numbers=true&include-verse-spans=false`;

    console.log(`  📖 Fetching API.Bible [${lang}]: ${passageId} from ${bibleId}...`);
    const resp = await fetch(url, {
      headers: { 'api-key': API_BIBLE_KEY },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`  ⚠️ API.Bible [${lang}] ${resp.status}: ${body.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const passage = data?.data;
    if (!passage?.content) {
      console.warn(`  ⚠️ API.Bible [${lang}]: No content returned`);
      return null;
    }

    // Clean up the text (remove extra whitespace, normalize)
    const text = passage.content
      .replace(/\s+/g, ' ')
      .replace(/\[\d+\]\s*/g, '') // remove verse markers like [11]
      .trim();

    console.log(`  ✅ API.Bible [${lang}]: ${text.substring(0, 80)}...`);

    return {
      text,
      reference: passage.reference || '',
      copyright: data?.meta?.fumsToken ? undefined : (passage.copyright || ''),
      fumsToken: data?.meta?.fumsToken || null,
    };
  } catch (err) {
    console.warn(`  ⚠️ API.Bible [${lang}] error:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch Bible text for all languages. Returns { de, en, pl } with text + copyright.
 */
async function fetchAllBibleTexts(reference) {
  const passageId = referenceToOsis(reference);
  if (!passageId) {
    console.warn('  ⚠️ Skipping Bible text fetch — could not parse reference');
    return null;
  }

  console.log(`\n📖 Fetching Bible text for passage: ${passageId}\n`);

  const results = {};
  for (const lang of LANGUAGES) {
    const bibleId = BIBLE_VERSIONS[lang];
    if (!bibleId) continue;
    results[lang] = await fetchBibleText(bibleId, passageId, lang);
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

  // 2. Fetch Bible text (API.Bible) — non-critical, continues even if it fails
  let gospelTexts = null;
  if (API_BIBLE_KEY) {
    try {
      gospelTexts = await fetchAllBibleTexts(gospel.reference);
    } catch (err) {
      console.warn('⚠️ Bible text fetch failed (non-critical):', err.message);
    }
  } else {
    console.log('⚠️ API_BIBLE_KEY not set — skipping Bible text fetch\n');
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
