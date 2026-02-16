#!/usr/bin/env node

/**
 * Daily impulse generator for Lumen.
 *
 * 1. Fetches today's Gospel reference from USCCB
 * 2. Calls Magisterium AI API for each language (de, en, pl)
 * 3. Writes JSON to impulses/<date>.json + impulses/latest.json
 *
 * NO user data is ever sent to the API — only the Gospel reference.
 * The API key comes from the MAGISTERIUM_API_KEY environment variable.
 */

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────
const MAGISTERIUM_API_URL = 'https://www.magisterium.com/api/v1/chat/completions';
const API_KEY = process.env.MAGISTERIUM_API_KEY;
const LANGUAGES = ['de', 'en', 'pl'];
const API_TIMEOUT_MS = 30000; // 30s timeout (CI has no rush)

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

  // 2. Generate impulses for all languages
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

  // 3. Write JSON files
  const output = {
    date: today,
    gospelRef: gospel.referenceDisplay,
    gospelRefOriginal: gospel.reference,
    generatedAt: new Date().toISOString(),
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
