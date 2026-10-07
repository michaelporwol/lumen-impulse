#!/usr/bin/env python3
"""Portugiesisch (Brasilien): die vier Evangelien aus der Bíblia Portuguesa Mundial.

Quelle: https://ebible.org/Scriptures/porbrbsl_usfm.zip (USFM)
Lizenz: https://ebible.org/porbrbsl/copyright.htm nennt wörtlich "Public Domain"
        (geprüft 07.10.2026; Stand der Quelldateien 19.08.2026).
Hinweis: Die Seite bezeichnet die Fassung als "rascunho de tradução … ainda em
revisão" und nennt keinen Übersetzer. Sie ist keine kirchlich approbierte
katholische Übersetzung (enthält aber die deuterokanonischen Bücher). Eine
gemeinfreie UND katholische Fassung in sauberer Textform gibt es derzeit nicht
(Figueiredo nur als OCR-Scan; Matos Soares frei erst ab 2028; CNBB, Ave-Maria,
Capuchinhos geschützt). Das ist der gleiche Status wie es/it (Reina-Valera 1909,
Riveduta 1927).

Aufruf: extract-gospels-pt.py <usfm-verzeichnis> <ausgabe.json>
"""
import json, re, sys
from pathlib import Path

SRC, OUT = Path(sys.argv[1]), Path(sys.argv[2])
BUECHER = {40: "MAT", 41: "MRK", 42: "LUK", 43: "JHN"}


def reinigen(t: str) -> str:
    t = re.sub(r"\\f .*?\\f\*", "", t, flags=re.S)        # Fußnoten
    t = re.sub(r"\\x .*?\\x\*", "", t, flags=re.S)        # Querverweise
    t = re.sub(r"\\\+?w (.*?)\|[^\\]*\\\+?w\*", r"\1", t)  # Wortattribute
    t = re.sub(r"\\\+?[a-z]+[0-9]*\*?", " ", t)           # übrige Marker (wj, q1, p …)
    t = re.sub(r"\s+", " ", t).strip()
    return re.sub(r" +([,.;:!?”’)])", r"\1", t)  # Leerraum vor Satzzeichen (entfernte Fußnote)


books = {}
for nr, code in BUECHER.items():
    datei = next(SRC.glob(f"*-{code}*.usfm"))
    roh = datei.read_text(encoding="utf-8")
    kapitel, akt_k = {}, None
    for teil in re.split(r"(?=\\c \d+)", roh):
        m = re.match(r"\\c (\d+)", teil)
        if not m:
            continue
        akt_k = m.group(1)
        verse = {}
        for vm in re.finditer(r"\\v (\d+)(?:-\d+)? (.*?)(?=\\v \d+|\Z)", teil, flags=re.S):
            verse[vm.group(1)] = reinigen(vm.group(2))
        kapitel[akt_k] = verse
    books[str(nr)] = kapitel
    print(f"{code}: {len(kapitel)} Kapitel, {sum(len(v) for v in kapitel.values())} Verse")

OUT.write_text(json.dumps({
    "translation": "Bíblia Portuguesa Mundial",
    "license": "public domain (ebible.org/porbrbsl/copyright.htm)",
    "books": books,
}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
