/**
 * Centralized Language Configuration
 *
 * All language-specific instructions are defined here.
 * To add a new language, simply add it to LANGUAGES object.
 */

const LANGUAGES = {
  // ============================================================================
  // GERMAN VARIANTS
  // ============================================================================

  'de-de': {
    code: 'de-de',
    name: 'Deutsch (Standard)',
    nameEnglish: 'German (Standard)',
    instruction: 'You MUST write your response in German. Use standard German spelling (Hochdeutsch). CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Use Präteritum for narrative prose, Perfekt in dialogue. (4) Standard vocabulary throughout. CORRECT: "größer", "süß", "er lief", "der Junge", "die Mütze", "der Eimer", "im Januar", "die Tomate", "gucken", "die Treppe" | WRONG: "groesser", "grösser", "der Bub", "die Kappe", "der Kübel".',
    note: '(Standard German: ß after long vowels, ss after short. Präteritum in narrative. CORRECT: "größer", "süß", "er lief" | WRONG: "grösser", "der Bub")'
  },

  'de-de-north': {
    code: 'de-de-north',
    name: 'Deutsch (Nord)',
    nameEnglish: 'German (North)',
    instruction: 'You MUST write your response in German. Use standard German spelling. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Strongly prefer Präteritum even in dialogue. (4) Use northern vocabulary: "Junge" (not "Bub"), "Mütze" (not "Kappe"), "Eimer" (not "Kübel"), "gucken/kucken" (not "schauen"), "Treppe" (not "Stiege"), "Januar", "dieses Jahr", "Tomate". (5) Crisper, more understated tone. CORRECT: "er lief", "er rief", "der Junge", "die Mütze", "gucken" | WRONG: "er ist gelaufen", "der Bub", "die Kappe", "schauen", "heuer", "grösser".',
    note: '(Northern German: Präteritum preferred. "Junge", "Mütze", "gucken". CORRECT: "er lief", "der Junge" | WRONG: "der Bub", "schauen")'
  },

  'de-de-south': {
    code: 'de-de-south',
    name: 'Deutsch (Süd)',
    nameEnglish: 'German (South)',
    instruction: 'You MUST write your response in German. Use standard German spelling. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Prefer Perfekt in dialogue, Präteritum acceptable in narrative. (4) Use southern vocabulary: "Bub" (not "Junge"), "Kappe" (not "Mütze"), "schauen" (not "gucken"), may use "Stiege" alongside "Treppe", "heuer" for "dieses Jahr". (5) Warmer, softer tone. CORRECT: "er hat gelacht", "der Bub", "die Kappe", "schauen", "heuer" | WRONG: "grösser", "der Junge", "gucken", "Jänner", "Paradeiser".',
    note: '(Southern German: Perfekt in dialogue. "Bub", "Kappe", "schauen", "heuer". CORRECT: "der Bub", "schauen" | WRONG: "grösser", "Jänner")'
  },

  'de-at': {
    code: 'de-at',
    name: 'Deutsch (Österreich)',
    nameEnglish: 'Austrian German',
    instruction: 'You MUST write your response in German. Use Austrian German spelling and vocabulary. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Strongly prefer Perfekt for all past tense, including narrative. (4) Use Austrian vocabulary: "Bub" (not "Junge"), "Kappe" (not "Mütze"), "Kübel" (not "Eimer"), "Stiege" (not "Treppe"), "schauen" (not "gucken"), "Jänner" (not "Januar"), "Feber" (not "Februar"), "heuer" (not "dieses Jahr"), "Paradeiser" (not "Tomate"), "Erdapfel" (not "Kartoffel"), "Sackerl" (not "Tüte"), "Sessel" (not "Stuhl"). CORRECT: "er ist gelaufen", "im Jänner", "der Bub", "die Stiege", "heuer", "das Sackerl" | WRONG: "er lief", "im Januar", "der Junge", "die Treppe", "die Tüte", "grösser".',
    note: '(Austrian German: Perfekt preferred. "Bub", "Jänner", "Paradeiser", "Sackerl". CORRECT: "er ist gelaufen", "im Jänner" | WRONG: "er lief", "grösser")'
  },

  'de-ch': {
    code: 'de-ch',
    name: 'Deutsch (Schweiz)',
    nameEnglish: 'Swiss German',
    instruction: 'You MUST write your response in German. Use Swiss Standard German spelling and vocabulary. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) NEVER use "ß", always use "ss" instead. (3) Prefer Perfekt for all past tense, including narrative. (4) Use Swiss vocabulary: "Bub" (not "Junge"), "Kappe" (not "Mütze"), "Rüebli" (not "Karotte"), "Velo" (not "Fahrrad"), "parkieren" (not "parken"), "grillieren" (not "grillen"), "Trottoir" (not "Bürgersteig"), "Lavabo" (not "Waschbecken"), "Natel" (not "Handy"), "Poulet" (not "Hähnchen"), "Glace" (not "Eis"), "Znüni/Zvieri" for snacks. (5) More formal register, no contractions. CORRECT: "grösser", "süss", "er ist gelaufen", "das Velo", "das Rüebli", "parkieren", "das Poulet" | WRONG: "größer", "süß", "er lief", "das Fahrrad", "die Karotte", "parken", "das Hähnchen".',
    note: '(Swiss German: NEVER ß, always ss. Perfekt preferred. "Velo", "Rüebli", "Poulet". CORRECT: "grösser", "süss" | WRONG: "größer", "süß")'
  },

  'de-it': {
    code: 'de-it',
    name: 'Deutsch (Südtirol)',
    nameEnglish: 'South Tyrolean German',
    instruction: 'You MUST write your response in German. Use South Tyrolean German spelling and vocabulary. CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs like Austrian standard. (3) Strongly prefer Perfekt for all past tense. (4) Use Austrian vocabulary as base: "Bub", "Kappe", "Kübel", "Stiege", "schauen", "Jänner", "heuer", "Paradeiser". (5) May include Italian-influenced words: "Ciao" for greetings, "Bar" (not "Café"), "Matura" (not "Abitur"). (6) Warmer, melodic tone similar to Austrian. CORRECT: "er ist gegangen", "der Bub", "die Kappe", "im Jänner", "heuer", "Ciao" | WRONG: "er ging", "der Junge", "die Mütze", "im Januar", "grösser", "dieses Jahr".',
    note: '(South Tyrolean: Austrian base + Italian influence. Perfekt preferred. "Bub", "Jänner", "Ciao". CORRECT: "er ist gegangen" | WRONG: "er ging", "grösser")'
  },

  // Legacy 'de' maps to Standard German for backwards compatibility
  'de': {
    code: 'de-de',
    name: 'Deutsch (Standard)',
    nameEnglish: 'German (Standard)',
    instruction: 'You MUST write your response in German. Use standard German spelling (Hochdeutsch). CRITICAL RULES: (1) Use ä, ö, ü - NEVER ae, oe, ue. (2) Use "ß" after long vowels and diphthongs, "ss" after short vowels. (3) Use Präteritum for narrative prose, Perfekt in dialogue. (4) Standard vocabulary throughout. CORRECT: "größer", "süß", "er lief", "der Junge", "die Mütze", "der Eimer", "im Januar", "die Tomate", "gucken", "die Treppe" | WRONG: "groesser", "grösser", "der Bub", "die Kappe", "der Kübel".',
    note: '(Standard German: ß after long vowels, ss after short. Präteritum in narrative. CORRECT: "größer", "süß", "er lief" | WRONG: "grösser", "der Bub")'
  },

  // ============================================================================
  // FRENCH VARIANTS
  // ============================================================================

  'fr-fr': {
    code: 'fr-fr',
    name: 'Français (France)',
    nameEnglish: 'French (France)',
    instruction: 'You MUST write your response in French. Use standard metropolitan French. CRITICAL RULES: (1) Use "soixante-dix" (70), "quatre-vingts" (80), "quatre-vingt-dix" (90). (2) Meal names: "petit-déjeuner" (breakfast), "déjeuner" (lunch), "dîner" (dinner). (3) Use standard vocabulary: "voiture" (car), "portable" (mobile phone), "week-end", "e-mail", "parking", "shopping". (4) Informal "tu" common among peers. CORRECT: "soixante-dix", "le petit-déjeuner", "le portable", "le week-end", "faire du shopping" | WRONG: "septante", "le déjeuner" for breakfast, "le natel", "la fin de semaine", "magasiner".',
    note: '(French France: soixante-dix/quatre-vingt-dix. "petit-déjeuner/déjeuner/dîner". CORRECT: "le portable", "le week-end" | WRONG: "septante", "le natel")'
  },

  'fr-ch': {
    code: 'fr-ch',
    name: 'Français (Suisse)',
    nameEnglish: 'French (Switzerland)',
    instruction: 'You MUST write your response in French. Use Swiss French vocabulary and expressions. CRITICAL RULES: (1) Use "septante" (70), "huitante" (80, in Vaud) or "quatre-vingts" (elsewhere), "nonante" (90). (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Use Swiss vocabulary: "Natel" (not "portable"), "action" (special offer), "cornet" (plastic bag), "poutser" (to clean), "fourrer" (to put/stuff), "bancomat" (ATM), "course d\'école" (school trip), "régie" (property management). (4) More formal register, prefer "vous". CORRECT: "septante", "nonante", "le souper", "le Natel", "un cornet", "une action" | WRONG: "soixante-dix", "quatre-vingt-dix", "le dîner" for dinner, "le portable", "un sac plastique", "une promo".',
    note: '(Swiss French: septante/nonante. "déjeuner/dîner/souper". "Natel", "cornet". CORRECT: "septante", "le Natel" | WRONG: "soixante-dix", "le portable")'
  },

  'fr-be': {
    code: 'fr-be',
    name: 'Français (Belgique)',
    nameEnglish: 'French (Belgium)',
    instruction: 'You MUST write your response in French. Use Belgian French vocabulary and expressions. CRITICAL RULES: (1) Use "septante" (70), "quatre-vingts" (80), "nonante" (90). (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Use Belgian vocabulary: "GSM" (not "portable"), "aubette" (bus shelter), "drache" (heavy rain), "kot" (student room), "sacoche" (bag), "pistolet" (bread roll), "praline" (chocolate), "torchon" (floor cloth), "savoir" used as "pouvoir" in some contexts ("tu sais me dire...?"). (4) Flemish influences in vocabulary. CORRECT: "septante", "nonante", "le souper", "le GSM", "une drache", "une aubette", "il drache" | WRONG: "soixante-dix", "quatre-vingt-dix", "le dîner" for dinner, "le portable", "une averse", "un abribus".',
    note: '(Belgian French: septante/nonante. "déjeuner/dîner/souper". "GSM", "drache". CORRECT: "septante", "il drache" | WRONG: "soixante-dix", "le portable")'
  },

  'fr-ca': {
    code: 'fr-ca',
    name: 'Français (Québec)',
    nameEnglish: 'French (Quebec)',
    instruction: 'You MUST write your response in French. Use Quebec French vocabulary and expressions. CRITICAL RULES: (1) Use "soixante-dix" (70), "quatre-vingts" (80), "quatre-vingt-dix" (90) like France. (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Avoid anglicisms, use Quebec terms: "fin de semaine" (not "week-end"), "courriel" (not "e-mail"), "stationnement" (not "parking"), "magasiner" (not "faire du shopping"), "char" (car, informal), "blonde/chum" (girlfriend/boyfriend), "bienvenue" (you\'re welcome), "dépanneur" (corner store), "tuque" (winter hat), "pogner" (to grab/catch). (4) More informal "tu" usage. CORRECT: "la fin de semaine", "le courriel", "magasiner", "bienvenue", "le dépanneur", "une tuque" | WRONG: "le week-end", "l\'e-mail", "faire du shopping", "de rien", "l\'épicerie du coin", "un bonnet".',
    note: '(Quebec French: soixante-dix but "fin de semaine", "courriel", "magasiner". CORRECT: "la fin de semaine", "bienvenue" | WRONG: "le week-end", "de rien")'
  },

  'fr-af': {
    code: 'fr-af',
    name: 'Français (Afrique)',
    nameEnglish: 'French (African)',
    instruction: 'You MUST write your response in French. Use African French based on French (France) with local adaptations. CRITICAL RULES: (1) Use "soixante-dix", "quatre-vingts", "quatre-vingt-dix". (2) More formal register overall. (3) Common vocabulary additions: "essencerie" (petrol station), "présentement" (currently), "être fatigué de" (to be sick of), "gérer" used broadly, "ça va aller" (it will be fine). (4) Often preserves older French expressions. (5) Direct, clear sentence structure preferred. (6) Avoid overly casual French slang from France. CORRECT: "soixante-dix", "présentement", "l\'essencerie", "ça va aller" | WRONG: "septante", "actuellement" (when meaning "now"), "la station-service" (acceptable but less common), French verlan slang.',
    note: '(African French: Based on France French. "présentement", "essencerie". CORRECT: "soixante-dix", "présentement" | WRONG: "septante", verlan slang)'
  },

  // Legacy 'fr' maps to Swiss French for backwards compatibility (Swiss is our primary market)
  'fr': {
    code: 'fr-ch',
    name: 'Français (Suisse)',
    nameEnglish: 'French (Switzerland)',
    instruction: 'You MUST write your response in French. Use Swiss French vocabulary and expressions. CRITICAL RULES: (1) Use "septante" (70), "huitante" (80, in Vaud) or "quatre-vingts" (elsewhere), "nonante" (90). (2) Meal names: "déjeuner" (breakfast), "dîner" (lunch), "souper" (dinner). (3) Use Swiss vocabulary: "Natel" (not "portable"), "action" (special offer), "cornet" (plastic bag), "poutser" (to clean), "fourrer" (to put/stuff), "bancomat" (ATM), "course d\'école" (school trip), "régie" (property management). (4) More formal register, prefer "vous". CORRECT: "septante", "nonante", "le souper", "le Natel", "un cornet", "une action" | WRONG: "soixante-dix", "quatre-vingt-dix", "le dîner" for dinner, "le portable", "un sac plastique", "une promo".',
    note: '(Swiss French: septante/nonante. "déjeuner/dîner/souper". "Natel", "cornet". CORRECT: "septante", "le Natel" | WRONG: "soixante-dix", "le portable")'
  },

  // ============================================================================
  // ENGLISH VARIANTS
  // ============================================================================

  'en-gb': {
    code: 'en-gb',
    name: 'English (UK)',
    nameEnglish: 'English (UK - British)',
    instruction: 'You MUST write your response in English. Use British spelling: "-our" (colour, favour, honour), "-ise" (organise, realise), "-re" (centre, theatre), "-lled/-lling" (travelled, travelling), "grey", "catalogue", "cheque". Use British vocabulary: "flat" (not "apartment"), "lift" (not "elevator"), "lorry" (not "truck"), "boot" (not "trunk"), "bonnet" (not "hood"), "trousers" (not "pants"), "holiday" (not "vacation"), "pavement" (not "sidewalk"), "post" (not "mail"), "rubbish" (not "garbage"), "nappy" (not "diaper"), "biscuit" (not "cookie"), "crisps" (not "chips"), "chips" (not "fries"), "queue" (not "line"), "torch" (not "flashlight"), "cinema" (not "movie theater"). Use "have got" more freely. Date format: day-month-year. CORRECT: "colour", "travelled", "the flat", "in hospital", "at the weekend", "have you got" | WRONG: "color", "traveled", "the apartment", "in the hospital", "on the weekend", "do you have".',
    note: '(British English: -our, -ise, -re spellings. "flat", "lift", "lorry", "holiday". CORRECT: "colour", "travelled" | WRONG: "color", "traveled")'
  },

  'en-us': {
    code: 'en-us',
    name: 'English (US)',
    nameEnglish: 'English (US - American)',
    instruction: 'You MUST write your response in English. Use American spelling: "-or" (color, favor, honor), "-ize" (organize, realize), "-er" (center, theater), "-ed/-ing" (traveled, traveling), "gray", "catalog", "check". Use American vocabulary: "apartment" (not "flat"), "elevator" (not "lift"), "truck" (not "lorry"), "trunk" (not "boot"), "hood" (not "bonnet"), "pants" (not "trousers"), "vacation" (not "holiday"), "sidewalk" (not "pavement"), "mail" (not "post"), "garbage/trash" (not "rubbish"), "diaper" (not "nappy"), "cookie" (not "biscuit"), "chips" (not "crisps"), "fries" (not "chips"), "line" (not "queue"), "flashlight" (not "torch"), "movie theater" (not "cinema"). Use "do you have" over "have you got". Date format: month-day-year. CORRECT: "color", "traveled", "the apartment", "in the hospital", "on the weekend", "do you have" | WRONG: "colour", "travelled", "the flat", "in hospital", "at the weekend", "have you got".',
    note: '(American English: -or, -ize, -er spellings. "apartment", "elevator", "truck", "vacation". CORRECT: "color", "traveled" | WRONG: "colour", "travelled")'
  },

  'en-ca': {
    code: 'en-ca',
    name: 'English (Canada)',
    nameEnglish: 'English (Canada)',
    instruction: 'You MUST write your response in English. Mix of British and American conventions. Use British spelling: "-our" (colour, favour), "-re" (centre, theatre), but American "-ize" (organize, realize). Use "travelled", "grey". Vocabulary mostly American with some British: "apartment", "elevator", "truck", "vacation", but "zed" (not "zee"), "washroom" (not "bathroom/restroom"), "toque" (winter hat), "runners" (sneakers), "garburator" (garbage disposal), "hydro" (electricity), "loonie/toonie" (coins), "grade one/two" (not "first/second grade"), "college" (also for technical schools), "eh" as conversation filler. Date format: varies, often day-month-year officially. CORRECT: "colour", "organize", "centre", "the washroom", "zed", "toque", "runners", "eh" | WRONG: "color", "organise", "center", "the restroom", "zee", "beanie", "sneakers".',
    note: '(Canadian English: British -our/-re but American -ize. "washroom", "toque", "runners", "eh". CORRECT: "colour", "organize" | WRONG: "color", "organise")'
  },

  'en-au': {
    code: 'en-au',
    name: 'English (Australia)',
    nameEnglish: 'English (Australia)',
    instruction: 'You MUST write your response in English. Use British spelling: "-our" (colour), "-ise" (organise), "-re" (centre), "travelled", "grey". Australian vocabulary: "arvo" (afternoon), "brekkie" (breakfast), "servo" (petrol station), "bottle-o" (bottle shop), "ute" (pickup truck), "thongs" (flip-flops), "capsicum" (bell pepper), "rockmelon" (cantaloupe), "footpath" (sidewalk), "chemist" (pharmacy), "boot" (car trunk), "bonnet" (car hood), "petrol" (not "gas"), "rubbish" (not "garbage"), "barrack for" (support a team), "heaps" (very/lots), "reckon" used frequently, "no worries" (you\'re welcome). Use "have got". Informal, abbreviated style common. CORRECT: "colour", "organise", "the chemist", "no worries", "heaps good", "I reckon", "this arvo" | WRONG: "color", "organize", "the pharmacy", "you\'re welcome", "very good", "I think", "this afternoon".',
    note: '(Australian English: British spelling. "arvo", "brekkie", "servo", "no worries", "heaps". CORRECT: "colour", "this arvo" | WRONG: "color", "this afternoon")'
  },

  'en-ie': {
    code: 'en-ie',
    name: 'English (Ireland)',
    nameEnglish: 'English (Ireland)',
    instruction: 'You MUST write your response in English. Use British spelling: "-our" (colour), "-ise" (organise), "-re" (centre). Irish vocabulary and expressions: "press" (cupboard), "messages" (shopping/errands), "bold" (naughty), "mineral" (soft drink), "runner" (sneaker), "yoke" (thing/object), "give out" (to complain), "gas" (funny), "grand" (fine/okay), "fierce" (very), "half [number]" for time (half two = 2:30), "amn\'t" (am not), "so" at end of sentences, "your man/your one" (that guy/that woman), "craic" (fun). Distinctive use of "after" + gerund: "I\'m after finishing". Often omit "yes/no" in responses. CORRECT: "colour", "the press", "doing the messages", "that\'s gas", "he\'s fierce tired", "I\'m after eating", "grand so" | WRONG: "color", "the cupboard", "running errands", "that\'s funny", "he\'s very tired", "I just ate", "fine then".',
    note: '(Irish English: British spelling. "press", "messages", "gas", "grand", "fierce", "craic". CORRECT: "I\'m after eating" | WRONG: "I just ate")'
  },

  'en-za': {
    code: 'en-za',
    name: 'English (South Africa)',
    nameEnglish: 'English (South Africa)',
    instruction: 'You MUST write your response in English. Use British spelling: "-our" (colour), "-ise" (organise), "-re" (centre). South African vocabulary (including Afrikaans influences): "robot" (traffic light), "bakkie" (pickup truck), "braai" (barbecue), "lekker" (nice/great), "ja" (yes), "now-now" (soon), "just now" (later/eventually), "shame" (expression of sympathy, not embarrassment), "howzit" (hello), "is it?" (really?), "café" (corner shop), "circle" (roundabout), "globe" (lightbulb), "tackies" (sneakers), "biltong" (dried meat). "Busy" + gerund for ongoing action: "I\'m busy cooking". CORRECT: "colour", "the robot", "a bakkie", "lekker", "shame, man", "now-now", "I\'m busy reading" | WRONG: "color", "the traffic light", "a pickup", "nice", "that\'s sad", "soon", "I\'m reading".',
    note: '(South African English: British spelling + Afrikaans. "robot", "bakkie", "braai", "lekker", "now-now". CORRECT: "the robot" | WRONG: "the traffic light")'
  },

  // Legacy 'en' maps to British English for backwards compatibility
  'en': {
    code: 'en-gb',
    name: 'English (UK)',
    nameEnglish: 'English (UK - British)',
    instruction: 'You MUST write your response in English. Use British spelling: "-our" (colour, favour, honour), "-ise" (organise, realise), "-re" (centre, theatre), "-lled/-lling" (travelled, travelling), "grey", "catalogue", "cheque". Use British vocabulary: "flat" (not "apartment"), "lift" (not "elevator"), "lorry" (not "truck"), "boot" (not "trunk"), "bonnet" (not "hood"), "trousers" (not "pants"), "holiday" (not "vacation"), "pavement" (not "sidewalk"), "post" (not "mail"), "rubbish" (not "garbage"), "nappy" (not "diaper"), "biscuit" (not "cookie"), "crisps" (not "chips"), "chips" (not "fries"), "queue" (not "line"), "torch" (not "flashlight"), "cinema" (not "movie theater"). Use "have got" more freely. Date format: day-month-year. CORRECT: "colour", "travelled", "the flat", "in hospital", "at the weekend", "have you got" | WRONG: "color", "traveled", "the apartment", "in the hospital", "on the weekend", "do you have".',
    note: '(British English: -our, -ise, -re spellings. "flat", "lift", "lorry", "holiday". CORRECT: "colour", "travelled" | WRONG: "color", "traveled")'
  },

  // ============================================================================
  // ITALIAN VARIANTS
  // ============================================================================

  'it-it': {
    code: 'it-it',
    name: 'Italiano (Standard)',
    nameEnglish: 'Italian (Standard)',
    instruction: 'You MUST write your response in Italian. Use standard Italian based on Tuscan literary tradition. Use passato prossimo for recent past in speech and informal writing, passato remoto for distant past and formal narrative. Standard vocabulary: "cellulare" (mobile phone), "frigorifero" (fridge), "automobile/macchina" (car), "anguria" (watermelon), "ragazzo/ragazza" (boy/girl), "sciocco" (silly/foolish), "soltanto" (only). Use "che cosa" or "cosa" for "what". Formal register uses "Lei" for polite address. CORRECT: "Che cosa fai?", "il cellulare", "l\'anguria", "sono andato ieri" | WRONG: "Che azione!", "il natel", "il cocomero" (regional), "tengo fame".',
    note: '(Standard Italian: passato prossimo/remoto. "cellulare", "anguria". CORRECT: "il cellulare", "sono andato" | WRONG: "il natel", "tengo fame")'
  },

  'it-ch': {
    code: 'it-ch',
    name: 'Italiano (Svizzera)',
    nameEnglish: 'Italian (Switzerland)',
    instruction: 'You MUST write your response in Italian. Use Swiss Italian with German and French influences. Use standard Italian grammar but Swiss vocabulary: "azione" (special offer), "natel" (mobile phone, from German), "autopostale" (postal bus), "tassì" (taxi, stress on final syllable), "supermercato" or "negozio" (not "grande magazzino"), "scuola media" (middle school), "liceo" (all secondary schools), "comune" (municipality, used frequently), "formazione" (education/training), "stazione di servizio" (not "benzinaio"). More formal register overall. Administrative terms often differ from Italy. French-influenced: "controllare" (to check), "malgrado" (despite). CORRECT: "un\'azione speciale", "il natel", "l\'autopostale", "il tassì", "la formazione professionale" | WRONG: "una promo", "il cellulare", "il pullman", "il taxi" (Italian stress), "l\'addestramento".',
    note: '(Swiss Italian: "azione", "natel", "autopostale", "tassì". CORRECT: "il natel", "l\'autopostale" | WRONG: "il cellulare", "il pullman")'
  },

  'it-it-north': {
    code: 'it-it-north',
    name: 'Italiano (Nord)',
    nameEnglish: 'Italian (Northern)',
    instruction: 'You MUST write your response in Italian. Use standard Italian with northern regional coloring (Lombardia, Piemonte, Veneto, Emilia-Romagna). Prefer passato prossimo almost exclusively, even for distant past. Use "cosa" (not "che cosa"). Northern vocabulary: "anguria" (watermelon), "ragazzo" (boy), "sciocco" (silly), "parlare" (to speak). More direct, business-like tone. Use "scherzare" (to joke). Common expressions: "magari" (maybe/I wish), "boh" (I don\'t know). Less emphatic than southern variants. CORRECT: "Cosa fai?", "l\'anguria", "sono andato" (even for distant past), "mica male", "boh, non so" | WRONG: "Che cosa vuoi?", "il cocomero", "andai" (passato remoto in speech), "tengo", "guaglione".',
    note: '(Northern Italian: passato prossimo preferred. "cosa", "anguria", "magari", "boh". CORRECT: "sono andato", "boh" | WRONG: "andai", "tengo")'
  },

  'it-it-central': {
    code: 'it-it-central',
    name: 'Italiano (Centro/Toscana)',
    nameEnglish: 'Italian (Central/Tuscan)',
    instruction: 'You MUST write your response in Italian. Use standard Italian with Tuscan coloring (Toscana, Umbria, northern Lazio). Closest to literary standard. Use both passato prossimo and passato remoto appropriately. Tuscan vocabulary: "cencio" (rag), "balocco" (toy), "desinare" (lunch, formal), "grulleria" (foolishness), "gote" (cheeks), "cocomero" (watermelon), "bischero" (fool, informal). Use "codesto" (that near you) in formal writing. "Babbo" (dad, not "papà"). Common expression: "icché" for "che cosa" in informal speech. CORRECT: "il cocomero", "il babbo", "codesto libro", "che grulleria!" | WRONG: "l\'anguria", "il papà" (acceptable but less Tuscan), "tengo", "sto + gerund" overuse.',
    note: '(Tuscan Italian: "cocomero", "babbo", "codesto", "bischero". CORRECT: "il babbo", "il cocomero" | WRONG: "il papà", "l\'anguria")'
  },

  'it-it-south': {
    code: 'it-it-south',
    name: 'Italiano (Sud)',
    nameEnglish: 'Italian (Southern)',
    instruction: 'You MUST write your response in Italian. Use standard Italian with southern regional coloring (Campania, Calabria, Sicilia, Puglia). Use "tenere" alongside "avere" for possession: "tengo fame" (I\'m hungry). Prefer passato remoto even for recent events in narrative. Southern vocabulary: "guaglione/guagliona" (boy/girl, Napoli), "picciliddru" (child, Sicilia), "mozzarella", "pummarola" (tomato sauce). More emphatic expressions, use "assai" (very/much), "mo\'" (now), "stare + gerund" frequently. Warmer, more expressive tone. "Ué" as interjection. Food terms often standard in all Italian. CORRECT: "tengo fame", "vieni mo\'!", "è bello assai", "andai ieri" (passato remoto for yesterday), "ué!" | WRONG: "ho fame" (correct but less southern), "vieni adesso", "è molto bello", "sono andato" (for narrative).',
    note: '(Southern Italian: "tengo", passato remoto, "assai", "mo\'", "ué". CORRECT: "tengo fame", "andai ieri" | WRONG: "ho fame", "sono andato")'
  },

  'it-sm': {
    code: 'it-sm',
    name: 'Italiano (San Marino)',
    nameEnglish: 'Italian (San Marino)',
    instruction: 'You MUST write your response in Italian. Use essentially identical to standard Italian (it-it) with minor local administrative terms. Use standard Italian grammar, spelling, and vocabulary throughout. Local terms: "Capitani Reggenti" (heads of state), "castello" (administrative district), "Consiglio Grande e Generale" (parliament). Sammarinese identity reflected in references to institutions, not language variation. Formal register for official contexts. CORRECT: "il Capitano Reggente", "il castello di Serravalle", standard Italian throughout | WRONG: Swiss or regional Italian variants.',
    note: '(San Marino Italian: Standard Italian + local administrative terms. CORRECT: "Capitani Reggenti", "castello" | WRONG: Swiss/regional variants)'
  },

  // Legacy 'it' maps to Standard Italian
  'it': {
    code: 'it-it',
    name: 'Italiano (Standard)',
    nameEnglish: 'Italian (Standard)',
    instruction: 'You MUST write your response in Italian. Use standard Italian based on Tuscan literary tradition. Use passato prossimo for recent past in speech and informal writing, passato remoto for distant past and formal narrative. Standard vocabulary: "cellulare" (mobile phone), "frigorifero" (fridge), "automobile/macchina" (car), "anguria" (watermelon), "ragazzo/ragazza" (boy/girl), "sciocco" (silly/foolish), "soltanto" (only). Use "che cosa" or "cosa" for "what". Formal register uses "Lei" for polite address. CORRECT: "Che cosa fai?", "il cellulare", "l\'anguria", "sono andato ieri" | WRONG: "Che azione!", "il natel", "il cocomero" (regional), "tengo fame".',
    note: '(Standard Italian: passato prossimo/remoto. "cellulare", "anguria". CORRECT: "il cellulare", "sono andato" | WRONG: "il natel", "tengo fame")'
  }
};

/**
 * Get full language instruction for a language code
 * @param {string} langCode - German: 'de-ch', 'de-de', 'de-at', 'de-it', 'de-de-north', 'de-de-south', 'de' | French: 'fr-fr', 'fr-ch', 'fr-be', 'fr-ca', 'fr-af', 'fr' | 'en'
 * @returns {string} Full instruction for AI
 */
function getLanguageInstruction(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.instruction;
}

/**
 * Get short language note (for prompts that already specify language)
 * @param {string} langCode
 * @returns {string} Short note with spelling rules
 */
function getLanguageNote(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.note;
}

/**
 * Get language name in that language
 * @param {string} langCode
 * @returns {string} e.g., 'Deutsch (Schweiz)', 'Français', 'English'
 */
function getLanguageName(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.name;
}

/**
 * Get language name in English
 * @param {string} langCode
 * @returns {string} e.g., 'German (Switzerland)', 'French', 'English'
 */
function getLanguageNameEnglish(langCode) {
  const lang = LANGUAGES[langCode] || LANGUAGES.en;
  return lang.nameEnglish;
}

/**
 * Get list of available languages for UI
 * @returns {Array} List of {code, name, nameEnglish}
 */
function getAvailableLanguages() {
  return [
    // German variants
    { code: 'de-de', name: 'Deutsch (Standard)', nameEnglish: 'German (Standard)' },
    { code: 'de-de-north', name: 'Norddeutsch', nameEnglish: 'German (North)' },
    { code: 'de-de-south', name: 'Süddeutsch', nameEnglish: 'German (South)' },
    { code: 'de-at', name: 'Deutsch (Österreich)', nameEnglish: 'Austrian German' },
    { code: 'de-ch', name: 'Deutsch (Schweiz)', nameEnglish: 'Swiss German' },
    { code: 'de-it', name: 'Deutsch (Südtirol)', nameEnglish: 'South Tyrolean German' },
    // French variants
    { code: 'fr-fr', name: 'Français (France)', nameEnglish: 'French (France)' },
    { code: 'fr-ch', name: 'Français (Suisse)', nameEnglish: 'French (Switzerland)' },
    { code: 'fr-be', name: 'Français (Belgique)', nameEnglish: 'French (Belgium)' },
    { code: 'fr-ca', name: 'Français (Québec)', nameEnglish: 'French (Quebec)' },
    { code: 'fr-af', name: 'Français (Afrique)', nameEnglish: 'French (African)' },
    // English variants
    { code: 'en-gb', name: 'English (UK)', nameEnglish: 'English (UK - British)' },
    { code: 'en-us', name: 'English (US)', nameEnglish: 'English (US - American)' },
    { code: 'en-ca', name: 'English (Canada)', nameEnglish: 'English (Canada)' },
    { code: 'en-au', name: 'English (Australia)', nameEnglish: 'English (Australia)' },
    { code: 'en-ie', name: 'English (Ireland)', nameEnglish: 'English (Ireland)' },
    { code: 'en-za', name: 'English (South Africa)', nameEnglish: 'English (South Africa)' },
    // Italian variants
    { code: 'it-it', name: 'Italiano (Standard)', nameEnglish: 'Italian (Standard)' },
    { code: 'it-ch', name: 'Italiano (Svizzera)', nameEnglish: 'Italian (Switzerland)' },
    { code: 'it-it-north', name: 'Italiano (Nord)', nameEnglish: 'Italian (Northern)' },
    { code: 'it-it-central', name: 'Italiano (Centro/Toscana)', nameEnglish: 'Italian (Central/Tuscan)' },
    { code: 'it-it-south', name: 'Italiano (Sud)', nameEnglish: 'Italian (Southern)' },
    { code: 'it-sm', name: 'Italiano (San Marino)', nameEnglish: 'Italian (San Marino)' }
  ];
}

module.exports = {
  LANGUAGES,
  getLanguageInstruction,
  getLanguageNote,
  getLanguageName,
  getLanguageNameEnglish,
  getAvailableLanguages
};
