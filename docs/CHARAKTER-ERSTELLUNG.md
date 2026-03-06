# Charaktererstellung - Detaillierte Dokumentation

## Übersicht
Die Charaktererstellung ist ein mehrstufiger Prozess, der es ermöglicht, personalisierte Charaktere mit verschiedenen Eigenschaften, Merkmalen und Beziehungen zu erstellen.

---

## Schritt 1: Grundlegende Charakterinformationen

### 1.1 Charaktername (Pflichtfeld)
- **Feldtyp**: Texteingabe
- **Validierung**: Muss ausgefüllt sein
- **Funktion**: Hauptidentifikator des Charakters
- **Besonderheit**: Bei Eingabe erfolgt automatische Geschlechtserkennung basierend auf:
  - Bekannten Namen (Sophia, Emma, Liam, Noah, etc.)
  - Endungen (a, e, ie, ine, elle = weiblich)

**Beispiel:**
```
Name: "Sophie" → Geschlecht wird automatisch auf "weiblich" gesetzt
Name: "Max" → Geschlecht wird automatisch auf "männlich" gesetzt
```

### 1.2 Geschlecht (Pflichtfeld)
- **Feldtyp**: Auswahlfeld (Dropdown)
- **Optionen**:
  - Männlich
  - Weiblich
  - Unbekannt
- **Standardwert**: Wird durch Namenserkennung vorausgefüllt
- **Anpassbar**: Kann manuell geändert werden

### 1.3 Alter (Pflichtfeld)
- **Feldtyp**: Zahleneingabe
- **Bereich**: 1-99 Jahre
- **Validierung**: Muss eine positive Zahl sein
- **Verwendung**: Beeinflusst die Altersangabe in der Geschichte

---

## Schritt 2: Visuelle Beschreibung

### 2.1 Charakterfoto (Optional)
- **Feldtyp**: Datei-Upload
- **Akzeptierte Formate**: Alle gängigen Bildformate (jpg, png, gif, etc.)
- **Funktion**:
  - Wird als Vorschaubild angezeigt
  - Hilft bei der Visualisierung des Charakters
  - Kann für KI-generierte Illustrationen verwendet werden
- **Speicherung**: Als Data URL im Browser
- **Darstellung**:
  - 20x20 Rundformat in der Charakterübersicht
  - 32x32 in Beziehungsansicht
  - Wird mit `object-cover` zugeschnitten

**Technische Details:**
```javascript
// Foto wird als Data URL gespeichert
reader.readAsDataURL(file);
// Gespeichert in: char.photoUrl
```

### 2.2 Alternative: Textbeschreibung

#### 2.2.1 Haarfarbe (Optional)
- **Feldtyp**: Texteingabe
- **Beispiele**: Blond, Braun, Schwarz, Rot, Grau
- **Verwendung**: Wird in Prompt nur eingefügt, wenn ausgefüllt

#### 2.2.2 Weitere Merkmale (Optional)
- **Feldtyp**: Mehrzeiliges Textfeld (Textarea)
- **Zweck**: Detaillierte physische Beschreibung
- **Beispiele**:
  ```
  - Blaue Augen, trägt eine Brille
  - Hat Sommersprossen
  - Große Ohren, lockiges Haar
  - Trägt immer einen roten Schal
  ```
- **Verwendung**: Nur in Prompt, wenn ausgefüllt

---

## Schritt 3: Charaktereigenschaften

### 3.1 Stärken (Pflichtfeld)
- **Minimum**: 3 Stärken
- **Maximum**: Unbegrenzt
- **Auswahlmethode**: Multi-Select Pills/Tags
- **Feldtyp**: Vorauswahl + Custom Input

#### Vorgegebene Stärken (Mehrsprachig):

**Englisch:**
- Brave, Smart, Kind, Strong, Fast, Creative, Funny, Leader, Helpful, Patient
- Honest, Loyal, Curious, Determined, Caring, Confident, Cheerful, Generous
- Clever, Adventurous, Resourceful, Protective, Imaginative, Hardworking, Trustworthy

**Deutsch:**
- Mutig, Klug, Freundlich, Stark, Schnell, Kreativ, Lustig, Führungspersönlichkeit
- Hilfsbereit, Geduldig, Ehrlich, Treu, Neugierig, Entschlossen, Fürsorglich
- Selbstbewusst, Fröhlich, Großzügig, Schlau, Abenteuerlustig, Einfallsreich
- Beschützend, Fantasievoll, Fleißig, Vertrauenswürdig

**Französisch:**
- Courageux, Intelligent, Gentil, Fort, Rapide, Créatif, Drôle, Leader
- Serviable, Patient, Honnête, Loyal, Curieux, Déterminé, Attentionné
- Confiant, Joyeux, Généreux, Astucieux, Aventureux, Débrouillard
- Protecteur, Imaginatif, Travailleur, Digne de confiance

#### Eigene Stärken hinzufügen:
```
1. Texteingabe für neue Stärke
2. Enter-Taste oder Plus-Button klicken
3. Stärke wird zur Liste hinzugefügt
4. Automatisch als ausgewählt markiert
```

**UI-Verhalten:**
- Ausgewählte Stärken: Grüner Hintergrund (`bg-green-500`)
- Nicht ausgewählt: Grauer Hintergrund (`bg-gray-200`)
- Zähler zeigt aktuelle Auswahl: "Ausgewählt: X"

### 3.2 Schwächen (Pflichtfeld)
- **Minimum**: 2 Schwächen
- **Maximum**: Unbegrenzt
- **Funktionsweise**: Identisch zu Stärken

#### Vorgegebene Schwächen (Mehrsprachig):

**Englisch:**
- Shy, Clumsy, Impatient, Forgetful, Messy, Talkative, Stubborn, Lazy
- Greedy, Jealous, Anxious, Distracted, Reckless, Bossy, Easily scared
- Too trusting, Perfectionist, Indecisive, Secretive, Boastful
- Quick-tempered, Careless, Overly cautious, Selfish

**Deutsch:**
- Schüchtern, Tollpatschig, Ungeduldig, Vergesslich, Unordentlich
- Gesprächig, Stur, Faul, Gierig, Eifersüchtig, Ängstlich, Abgelenkt
- Leichtsinnig, Herrschsüchtig, Leicht ängstlich, Zu vertrauensvoll
- Perfektionist, Unentschlossen, Verschlossen, Prahlerisch, Jähzornig
- Nachlässig, Übervorsichtig, Egoistisch

**Französisch:**
- Timide, Maladroit, Impatient, Distrait, Désordonné, Bavard, Têtu
- Paresseux, Avide, Jaloux, Anxieux, Imprudent, Autoritaire
- Facilement effrayé, Trop confiant, Perfectionniste, Indécis, Secret
- Vantard, Colérique, Négligent, Trop prudent, Égoïste

**UI-Verhalten:**
- Ausgewählte Schwächen: Orange Hintergrund (`bg-orange-500`)
- Nicht ausgewählt: Grauer Hintergrund (`bg-gray-200`)

### 3.3 Ängste (Optional)
- **Minimum**: 0 (Optional)
- **Maximum**: Unbegrenzt
- **Funktionsweise**: Wie Stärken/Schwächen

#### Vorgegebene Ängste (Mehrsprachig):

**Englisch:**
- Fear of heights
- Fear of spiders
- Fear of the dark
- Fear of being alone
- Fear of loud noises

**Deutsch:**
- Höhenangst
- Angst vor Spinnen
- Angst vor der Dunkelheit
- Angst allein zu sein
- Angst vor lauten Geräuschen

**Französisch:**
- Peur du vide
- Peur des araignées
- Peur du noir
- Peur d'être seul
- Peur des bruits forts

**UI-Verhalten:**
- Ausgewählte Ängste: Roter Hintergrund (`bg-red-500`)
- Nicht ausgewählt: Grauer Hintergrund (`bg-gray-200`)

### 3.4 Besondere Details (Optional)
- **Feldtyp**: Mehrzeiliges Textfeld (Textarea)
- **Zweck**: Zusätzliche Charakterinformationen
- **Beispiele**:
  ```
  - Lieblingstier: Hunde
  - Träumt davon zu fliegen
  - Trägt immer einen roten Hut
  - Sammelt Steine
  - Spielt gerne Fußball
  ```
- **Rows**: 3 Zeilen
- **Verwendung**: Nur in Prompt, wenn ausgefüllt

---

## Schritt 4: Charaktervalidierung

### Validierungsregeln beim Speichern:
```javascript
const canSave =
  currentCharacter.name &&                    // Name muss vorhanden sein
  currentCharacter.strengths.length >= 3 &&   // Mind. 3 Stärken
  currentCharacter.weaknesses.length >= 2;    // Mind. 2 Schwächen
```

### Speicher-Button-Verhalten:
- **Aktiviert**: Grüner Hintergrund, klickbar
- **Deaktiviert**: Grauer Hintergrund, Cursor: not-allowed
- **Feedback**: Zeigt aktuellen Status der Validierung

---

## Schritt 5: Charakterübersicht nach Erstellung

### 5.1 Erfolgsanzeige
Nach erfolgreichem Speichern erscheint:
- **Großes Häkchen-Symbol** (Icon: `check`, 64px)
- **Nachricht**: "Charakter erstellt!"
- **Zähler**: "Du hast bisher X Charakter(e) erstellt."

### 5.2 Aktionen
Zwei Buttons stehen zur Verfügung:
1. **"Weiteren Charakter erstellen"**
   - Icon: Plus
   - Startet neue Charaktererstellung

2. **"Weiter zu Beziehungen"**
   - Icon: Pfeil rechts
   - Initialisiert Beziehungsmatrix
   - Geht zu Schritt 3 (Beziehungen definieren)

### 5.3 Charakterkarte in Übersicht
Jeder erstellte Charakter wird angezeigt mit:
- **Foto**: Rund, 80x80px (falls vorhanden)
- **Name**: Fett gedruckt, zentriert
- **Alter & Geschlecht**: Kleinerer Text, zentriert
- **Stärken**: Erste 3 Stärken (gekürzt)
- **Aktionen**:
  - **Bearbeiten-Button**: Blau, lädt Charakter in Editor
  - **Löschen-Button**: Rot, entfernt mit Bestätigung

---

## Datenstruktur eines Charakters

```javascript
{
  id: 1234567890123,              // Timestamp als eindeutige ID
  name: "Sophie",                 // String, Pflicht
  gender: "female",               // "male" | "female" | "other"
  age: "8",                       // String (Zahl)

  // ============================================
  // PHYSISCHE MERKMALE (für Bildgenerierung)
  // Diese Felder werden NUR für die Bildgenerierung verwendet
  // ============================================
  photo: File | null,             // File-Objekt (Original-Upload)
  photoUrl: "data:image/...",     // Data URL oder null (für API-Referenz)
  height: "120cm",                // Größe (optional)
  build: "schlank",               // Körperbau (optional)
  hairColor: "Blond",             // Haarfarbe (optional)
  clothing: "blaues T-Shirt",     // Kleidung - extrahiert aus Foto (optional)
  otherFeatures: "Blaue Augen",   // Weitere physische Merkmale (optional)

  // ============================================
  // PSYCHOLOGISCHE MERKMALE (für Textgenerierung)
  // Diese Felder werden NUR für die Story-Generierung verwendet
  // ============================================
  strengths: [                    // Min. 3 - Charakterstärken
    "Mutig",
    "Klug",
    "Freundlich"
  ],
  weaknesses: [                   // Min. 2 - Charakterschwächen
    "Ungeduldig",
    "Tollpatschig"
  ],
  fears: [                        // Optional - Ängste
    "Höhenangst"
  ],
  specialDetails: "Liebt Hunde"   // Optional - Besondere Details/Hobbys
}
```

---

## Verwendung der Charakterdaten

### WICHTIG: Trennung von physischen und psychologischen Merkmalen

Die Charakterdaten werden für zwei verschiedene Zwecke verwendet:

1. **Story-Generierung (Text)** - Nutzt psychologische Merkmale
2. **Bild-Generierung** - Nutzt physische Merkmale

Diese Trennung ist wichtig, da:
- Die KI für Textgenerierung Persönlichkeitsmerkmale braucht, um interessante Geschichten zu schreiben
- Die KI für Bildgenerierung nur das visuelle Erscheinungsbild braucht

---

### Gemeinsame Merkmale (für Text UND Bild):

Das **Hauptcharakter-Flag** (`mainCharacters` Array) wird für BEIDE Zwecke verwendet:

| Verwendung | Auswirkung |
|------------|------------|
| **Story-Text** | Hauptcharaktere bekommen mehr Fokus in der Geschichte |
| **Cover-Bilder** | Hauptcharaktere werden ZENTRAL und GROSS im Bild platziert |
| **Szenen-Bilder** | Hauptcharaktere werden als "MAIN CHARACTER" markiert |

```javascript
// mainCharacters ist ein Array von Character-IDs
mainCharacters: [1234567890123]  // IDs der Hauptcharaktere (max. 2)
```

---

### Story-Prompt (psychologische Merkmale):

Für die Generierung der Geschichte werden folgende Felder verwendet:
- `name`, `gender`, `age` (Basisinformationen)
- `isMainCharacter` (aus mainCharacters Array)
- `strengths` (Stärken)
- `weaknesses` (Schwächen)
- `fears` (Ängste)
- `specialDetails` (Besondere Details)

```javascript
// Beispiel Story-Prompt:
"Sophie (MAIN CHARACTER) (female, 8 years old):
Strengths: Mutig, Klug, Freundlich,
Weaknesses: Ungeduldig, Tollpatschig,
Fears: Höhenangst,
Special Details: Liebt Hunde"
```

---

### Bild-Prompt (physische Merkmale):

Für die Generierung der Bilder werden folgende Felder verwendet:
- `name`, `gender`, `age` (Basisinformationen)
- `isMainCharacter` (aus mainCharacters Array) - **für Positionierung im Bild**
- `height` (Größe)
- `build` (Körperbau)
- `hairColor` (Haarfarbe)
- `clothing` (Kleidung - aus Foto extrahiert)
- `otherFeatures` (Weitere physische Merkmale)
- `photoUrl` (Referenzbild für Konsistenz)

```javascript
// Beispiel Cover-Bild-Prompt:
"**MAIN CHARACTER(S) - Must be prominently featured in the CENTER of the image:**
⭐ MAIN: Sophie is a 8-year-old girl, 120cm, slim build, with blonde hair, blue eyes. Wearing: blue t-shirt

**Supporting characters (can appear in background or sides):**
Supporting: Max is a 10-year-old boy, 135cm, athletic build, with brown hair

**CRITICAL: Main character(s) must be the LARGEST and most CENTRAL figures in the composition.**"
```

**Hinweis:** Psychologische Merkmale (strengths, weaknesses, fears, specialDetails) werden NICHT an die Bildgenerierung übergeben, da sie für die visuelle Darstellung nicht relevant sind.

---

### Smart-Filtering:

Die `buildPrompt()`-Funktion für Story-Text fügt nur Felder hinzu, die tatsächlich Werte enthalten:
```javascript
const details = [];
if (char.strengths && char.strengths.length > 0) {
  details.push(`Strengths: ${char.strengths.join(', ')}`);
}
if (char.weaknesses && char.weaknesses.length > 0) {
  details.push(`Weaknesses: ${char.weaknesses.join(', ')}`);
}
if (char.fears && char.fears.length > 0) {
  details.push(`Fears: ${char.fears.join(', ')}`);
}
if (char.specialDetails) {
  details.push(`Special Details: ${char.specialDetails}`);
}
// NICHT: hairColor, clothing, otherFeatures, height, build (diese sind für Bilder)
```

Die `generateCharacterDescription()`-Funktion für Bilder:
```javascript
let description = `${char.name} is a ${age}-year-old ${gender}`;
if (char.height) description += `, ${char.height}`;
if (char.build) description += `, ${char.build} build`;
if (char.hairColor) description += `, with ${char.hairColor} hair`;
if (char.otherFeatures) description += `, ${char.otherFeatures}`;
if (char.clothing) description += `. Wearing: ${char.clothing}`;
// NICHT: strengths, weaknesses, fears, specialDetails (diese sind für Text)
```

---

## Bearbeitungsfunktionen

### Charakter bearbeiten:
```javascript
editCharacter(char) {
  // Lädt Charakter in Editor
  // Entfernt aus Liste temporär
  // Ermöglicht Neubearbeitung
}
```

### Charakter löschen:
```javascript
deleteCharacter(charId) {
  // Zeigt Bestätigungsdialog
  // Entfernt aus Charakterliste
  // Entfernt aus Hauptcharakteren
  // Löscht alle Beziehungen des Charakters
}
```

---

## Sprachunterstützung

Alle UI-Elemente und vordefinierten Listen sind in 3 Sprachen verfügbar:
- **Englisch (en)**
- **Deutsch (de)**
- **Französisch (fr)**

Die Sprache wird automatisch beim Start erkannt basierend auf:
```javascript
const browserLang = navigator.language || navigator.userLanguage;
if (browserLang.startsWith('de')) return 'de';
if (browserLang.startsWith('fr')) return 'fr';
return 'en'; // Standard
```

---

## Best Practices

### 1. Charaktervielfalt
- Erstelle mindestens 2 Charaktere für interessante Geschichten
- Wähle unterschiedliche Stärken und Schwächen
- Definiere klare Beziehungen zwischen Charakteren

### 2. Detailgrad
- Nutze optionale Felder für reichere Charaktere
- Beschreibe visuelle Merkmale für lebendige Geschichten
- Füge besondere Details hinzu für Persönlichkeit

### 3. Ausgewogenheit
- Balance zwischen Stärken und Schwächen
- Realistische Charaktere sind interessanter
- Ängste können Konfliktpotenzial schaffen

### 4. Hauptcharaktere
- Wähle 1-2 Hauptcharaktere (max. 2)
- Hauptcharaktere erhalten mehr Fokus in der Geschichte
- Gekennzeichnet mit ⭐ in Exporten

---

## Fehlerbehebung

### Problem: Speichern-Button deaktiviert
**Lösung**: Überprüfe Validierung
- Mindestens 3 Stärken ausgewählt?
- Mindestens 2 Schwächen ausgewählt?
- Name eingegeben?

### Problem: Eigene Eigenschaften erscheinen nicht
**Lösung**:
- Enter-Taste drücken oder Plus-Button klicken
- Prüfen ob bereits in Liste vorhanden

### Problem: Foto wird nicht angezeigt
**Lösung**:
- Nur Bildformate verwenden
- Dateigröße prüfen (Browser-Limit)
- Data URL wird im Browser gespeichert

---

## Export-Formate

### JSON-Export
Vollständige Charakterdaten inklusive:
- Alle Eigenschaften
- IDs für Beziehungen
- Custom-Erweiterungen

### Markdown-Export
Lesbare Übersicht mit:
- Charaktername + Hauptcharakter-Markierung
- Alle ausgefüllten Eigenschaften
- Formatierte Listen
- Beispiel:
  ```markdown
  ### 1. Sophie ⭐ (Main Character)

  - **Gender**: Weiblich
  - **Age**: 8 Jahre
  - **Hair Color**: Blond
  - **Strengths**: Mutig, Klug, Freundlich
  - **Weaknesses**: Ungeduldig, Tollpatschig
  - **Fears**: Höhenangst
  - **Special Details**: Liebt Hunde
  ```

---

## Technische Implementation

### React State Management
```javascript
const [currentCharacter, setCurrentCharacter] = useState(null);
const [characters, setCharacters] = useState([]);
const [showCharacterCreated, setShowCharacterCreated] = useState(false);
```

### Custom State
```javascript
const [customStrengths, setCustomStrengths] = useState([]);
const [customWeaknesses, setCustomWeaknesses] = useState([]);
const [customFears, setCustomFears] = useState([]);
```

### Geschlechtserkennung
```javascript
const detectGender = (name) => {
  const femaleSuffixes = ['a', 'e', 'ie', 'ine', 'elle'];
  const femaleNames = ['sophia', 'emma', 'olivia', ...];
  const maleNames = ['liam', 'noah', 'oliver', ...];

  // Logik zur Erkennung
  return 'male' | 'female' | 'other';
};
```

---

## Zusammenfassung

Die Charaktererstellung ermöglicht:
✅ Detaillierte, personalisierte Charaktere
✅ Flexible Eigenschaftswahl
✅ Visuelle und textuelle Beschreibung
✅ Mehrsprachige Unterstützung
✅ Smart Prompt-Generierung (nur gefüllte Felder)
✅ Export in verschiedenen Formaten
✅ Einfache Bearbeitung und Verwaltung

Alle Daten bleiben lokal im Browser gespeichert und werden nur für die Prompt-Generierung verwendet.
