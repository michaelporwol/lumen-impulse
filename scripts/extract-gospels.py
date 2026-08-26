#!/usr/bin/env python3
"""Zieht die vier Evangelien aus gemeinfreien Bibelausgaben und legt sie kompakt ab.

Warum ueberhaupt: Die Tagespipeline holt den Evangeliumstext bisher von
bolls.life, dort gibt es aber fuer Spanisch und Italienisch NUR
urheberrechtlich geschuetzte Fassungen (geprueft 26.08.2026: RV1960, NVI, NTV,
LBLA, Nuova Riveduta 2006). Statt einer Lizenz nehmen wir gemeinfreie Ausgaben
und legen die vier Evangelien einmal als Datei ab — mehr braucht die
Tageslesung nie, und der Generator wird damit unabhaengig von einer fremden API.

Quellen und Rechtslage (jede einzeln geprueft):
  es  Reina-Valera 1909      gemeinfrei (Ausgabe von 1909)
      -> scrollmapper/bible_databases, SpaRV.json
      Hinweis: Die katholische Straubinger-Fassung (Biblia Platense) waere
      inhaltlich die bessere Wahl, ist aber NICHT gemeinfrei: Straubinger starb
      am 23.03.1956, Schutzfrist 70 Jahre nach dem Tod, also erst ab 01.01.2027.
      Die Recherche-Notiz vom 26.08. sagt hier "gemeinfrei verfuegbar" — das
      stimmt so nicht. Ab 2027 kann getauscht werden.
  it  Giovanni Diodati 1649  gemeinfrei
      -> api.biblesupersearch.com (dort ausdruecklich copyright=0)
  fr  Augustin Crampon 1923  gemeinfrei UND katholisch (73 Buecher)
      -> scrollmapper/bible_databases, FreCrampon.json

Ergebnis: bibles/gospels-<lang>.json mit
  { "translation": …, "license": …, "books": { "40": { "1": { "1": "Vers" }}}}
Buchnummern wie in generate-impulse.js (40 Mt, 41 Mk, 42 Lk, 43 Joh).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/bibles")
OUT.mkdir(parents=True, exist_ok=True)

EVANGELIEN = {40: "Matthew", 41: "Mark", 42: "Luke", 43: "John"}
SCROLLMAPPER = "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/{}.json"
BSS = "https://api.biblesupersearch.com/api?bible={bible}&reference={book}%20{chapter}"


def hole(url: str, versuche: int = 3) -> bytes:
    for i in range(versuche):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except Exception as e:
            if i == versuche - 1:
                raise
            print(f"    erneut ({e})")
            time.sleep(3)
    raise RuntimeError


def aus_scrollmapper(datei: str, name: str, lizenz: str) -> dict:
    print(f"  lade {datei} …")
    d = json.loads(hole(SCROLLMAPPER.format(datei)))
    books: dict[str, dict] = {}
    for nummer, engl in EVANGELIEN.items():
        buch = next((b for b in d["books"] if b["name"].strip().lower() == engl.lower()), None)
        if not buch:
            raise SystemExit(f"{datei}: Buch {engl} nicht gefunden")
        kapitel = {}
        for k in buch["chapters"]:
            kapitel[str(k["chapter"])] = {
                str(v["verse"]): (v["text"] or "").strip() for v in k["verses"]
            }
        books[str(nummer)] = kapitel
        print(f"    {engl}: {len(kapitel)} Kapitel")
    return {"translation": name, "license": lizenz, "books": books}


def aus_biblesupersearch(bible: str, name: str, lizenz: str) -> dict:
    """Kapitelweise holen — die API liefert pro Anfrage ein Kapitel zuverlaessig."""
    kapitelzahl = {40: 28, 41: 16, 42: 24, 43: 21}
    books: dict[str, dict] = {}
    for nummer, engl in EVANGELIEN.items():
        kapitel = {}
        for k in range(1, kapitelzahl[nummer] + 1):
            url = BSS.format(bible=bible, book=engl, chapter=k)
            d = json.loads(hole(url))
            try:
                verses = d["results"][0]["verses"][bible][str(k)]
            except Exception:
                raise SystemExit(f"{bible} {engl} {k}: unerwartete Antwort {str(d)[:200]}")
            kapitel[str(k)] = {vn: (v["text"] or "").strip() for vn, v in verses.items()}
            time.sleep(0.2)   # freundlich zur fremden API
        books[str(nummer)] = kapitel
        print(f"    {engl}: {len(kapitel)} Kapitel")
    return {"translation": name, "license": lizenz, "books": books}


QUELLEN = {
    "es": lambda: aus_scrollmapper("SpaRV", "Reina-Valera 1909", "public domain"),
    "fr": lambda: aus_scrollmapper("FreCrampon", "Augustin Crampon 1923", "public domain"),
    "it": lambda: aus_biblesupersearch("diodati", "Giovanni Diodati 1649", "public domain"),
}


def main() -> int:
    for lang, quelle in QUELLEN.items():
        print(f"\n=== {lang} ===")
        daten = quelle()
        ziel = OUT / f"gospels-{lang}.json"
        ziel.write_text(json.dumps(daten, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        verse = sum(len(v) for b in daten["books"].values() for v in b.values())
        print(f"  → {ziel} ({ziel.stat().st_size // 1024} KB, {verse} Verse)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
