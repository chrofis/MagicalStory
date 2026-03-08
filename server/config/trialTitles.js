// server/config/trialTitles.js
// Pre-defined book titles for trial stories
// Grouped by base language: en (all English), de (all German incl. Austrian),
// gsw (Swiss German), fr (all French), it (all Italian)

const TRIAL_TITLES = {
  // ══════════════════════════════════════════════════════════════
  // ADVENTURE THEMES
  // ══════════════════════════════════════════════════════════════
  adventure: {
    pirate: {
      male: {
        en: "The Little Pirate's Great Adventure",
        de: "Das grosse Abenteuer des kleinen Piraten",
        gsw: "S grosse Abentüür vom chline Pirat",
        fr: "La Grande Aventure du Petit Pirate",
        it: "La Grande Avventura del Piccolo Pirata"
      },
      female: {
        en: "The Little Pirate's Great Adventure",
        de: "Das grosse Abenteuer der kleinen Piratin",
        gsw: "S grosse Abentüür vo de chline Piratin",
        fr: "La Grande Aventure de la Petite Pirate",
        it: "La Grande Avventura della Piccola Pirata"
      }
    },
    knight: {
      male: {
        en: "The Brave Knight and the Secret Kingdom",
        de: "Der tapfere Ritter und das geheime Königreich",
        gsw: "De tapfer Ritter und s gheime Chönigriich",
        fr: "Le Brave Chevalier et le Royaume Secret",
        it: "Il Coraggioso Cavaliere e il Regno Segreto"
      },
      female: {
        en: "The Brave Knight and the Secret Kingdom",
        de: "Die tapfere Ritterin und das geheime Königreich",
        gsw: "Die tapferi Ritterin und s gheime Chönigriich",
        fr: "La Brave Chevalière et le Royaume Secret",
        it: "La Coraggiosa Cavaliera e il Regno Segreto"
      }
    },
    cowboy: {
      male: {
        en: "Ride into the Sunset — A Wild West Tale",
        de: "Ritt in den Sonnenuntergang — Ein Wilder-Westen-Abenteuer",
        gsw: "Ritt in de Sunneundergang — Es Wilde-Weste-Abentüür",
        fr: "Chevauchée vers le Couchant — Un Conte du Far West",
        it: "Cavalcata nel Tramonto — Un'Avventura nel Selvaggio West"
      },
      female: {
        en: "Ride into the Sunset — A Wild West Tale",
        de: "Ritt in den Sonnenuntergang — Ein Wilder-Westen-Abenteuer",
        gsw: "Ritt in de Sunneundergang — Es Wilde-Weste-Abentüür",
        fr: "Chevauchée vers le Couchant — Un Conte du Far West",
        it: "Cavalcata nel Tramonto — Un'Avventura nel Selvaggio West"
      }
    },
    ninja: {
      male: {
        en: "Shadow of the Little Ninja",
        de: "Der Schatten des kleinen Ninja",
        gsw: "De Schatte vom chline Ninja",
        fr: "L'Ombre du Petit Ninja",
        it: "L'Ombra del Piccolo Ninja"
      },
      female: {
        en: "Shadow of the Little Ninja",
        de: "Der Schatten der kleinen Ninja",
        gsw: "De Schatte vo de chline Ninja",
        fr: "L'Ombre de la Petite Ninja",
        it: "L'Ombra della Piccola Ninja"
      }
    },
    viking: {
      male: {
        en: "Voyage of the Fearless Viking",
        de: "Die Reise des furchtlosen Wikingers",
        gsw: "D Reis vom furchtlose Wikinger",
        fr: "Le Voyage du Viking Intrépide",
        it: "Il Viaggio del Vichingo Intrepido"
      },
      female: {
        en: "Voyage of the Fearless Viking",
        de: "Die Reise der furchtlosen Wikingerin",
        gsw: "D Reis vo de furchtlose Wikingerin",
        fr: "Le Voyage de la Viking Intrépide",
        it: "Il Viaggio della Vichinga Intrepida"
      }
    },
    roman: {
      male: {
        en: "A Day in Ancient Rome",
        de: "Ein Tag im alten Rom",
        gsw: "En Tag im alte Rom",
        fr: "Une Journée dans la Rome Antique",
        it: "Un Giorno nell'Antica Roma"
      },
      female: {
        en: "A Day in Ancient Rome",
        de: "Ein Tag im alten Rom",
        gsw: "En Tag im alte Rom",
        fr: "Une Journée dans la Rome Antique",
        it: "Un Giorno nell'Antica Roma"
      }
    },
    egyptian: {
      male: {
        en: "The Secret of the Golden Pyramid",
        de: "Das Geheimnis der goldenen Pyramide",
        gsw: "S Gheimnis vo de goldige Pyramide",
        fr: "Le Secret de la Pyramide Dorée",
        it: "Il Segreto della Piramide Dorata"
      },
      female: {
        en: "The Secret of the Golden Pyramid",
        de: "Das Geheimnis der goldenen Pyramide",
        gsw: "S Gheimnis vo de goldige Pyramide",
        fr: "Le Secret de la Pyramide Dorée",
        it: "Il Segreto della Piramide Dorata"
      }
    },
    greek: {
      male: {
        en: "The Little Hero of Mount Olympus",
        de: "Der kleine Held vom Olymp",
        gsw: "De chli Held vom Olymp",
        fr: "Le Petit Héros de l'Olympe",
        it: "Il Piccolo Eroe dell'Olimpo"
      },
      female: {
        en: "The Little Heroine of Mount Olympus",
        de: "Die kleine Heldin vom Olymp",
        gsw: "Die chli Heldin vom Olymp",
        fr: "La Petite Héroïne de l'Olympe",
        it: "La Piccola Eroina dell'Olimpo"
      }
    },
    caveman: {
      male: {
        en: "The Stone Age Explorer",
        de: "Der Entdecker aus der Steinzeit",
        gsw: "De Entdecker us de Steizit",
        fr: "L'Explorateur de l'Âge de Pierre",
        it: "L'Esploratore dell'Età della Pietra"
      },
      female: {
        en: "The Stone Age Explorer",
        de: "Die Entdeckerin aus der Steinzeit",
        gsw: "D Entdeckerin us de Steizit",
        fr: "L'Exploratrice de l'Âge de Pierre",
        it: "L'Esploratrice dell'Età della Pietra"
      }
    },
    samurai: {
      male: {
        en: "The Way of the Little Samurai",
        de: "Der Weg des kleinen Samurai",
        gsw: "De Wäg vom chline Samurai",
        fr: "La Voie du Petit Samouraï",
        it: "La Via del Piccolo Samurai"
      },
      female: {
        en: "The Way of the Little Samurai",
        de: "Der Weg der kleinen Samurai",
        gsw: "De Wäg vo de chline Samurai",
        fr: "La Voie de la Petite Samouraï",
        it: "La Via della Piccola Samurai"
      }
    },
    wizard: {
      male: {
        en: "The Little Wizard and the Enchanted Spell",
        de: "Der kleine Zauberer und der verzauberte Spruch",
        gsw: "De chli Zauberer und de verzauberti Spruch",
        fr: "Le Petit Sorcier et le Sortilège Enchanté",
        it: "Il Piccolo Mago e l'Incantesimo Fatato"
      },
      female: {
        en: "The Little Witch and the Enchanted Spell",
        de: "Die kleine Zauberin und der verzauberte Spruch",
        gsw: "Die chli Zauberin und de verzauberti Spruch",
        fr: "La Petite Sorcière et le Sortilège Enchanté",
        it: "La Piccola Maga e l'Incantesimo Fatato"
      }
    },
    dragon: {
      male: {
        en: "The Boy Who Befriended a Dragon",
        de: "Der Junge, der einen Drachen zähmte",
        gsw: "De Bueb, wo en Drache zähmt het",
        fr: "Le Garçon qui Apprivoisa un Dragon",
        it: "Il Ragazzo che Addomesticò un Drago"
      },
      female: {
        en: "The Girl Who Befriended a Dragon",
        de: "Das Mädchen, das einen Drachen zähmte",
        gsw: "S Meitli, wo en Drache zähmt het",
        fr: "La Fille qui Apprivoisa un Dragon",
        it: "La Ragazza che Addomesticò un Drago"
      }
    },
    superhero: {
      male: {
        en: "The World's Smallest Superhero",
        de: "Der kleinste Superheld der Welt",
        gsw: "De chlinst Superheld vo de Wält",
        fr: "Le Plus Petit Super-Héros du Monde",
        it: "Il Più Piccolo Supereroe del Mondo"
      },
      female: {
        en: "The World's Smallest Superheroine",
        de: "Die kleinste Superheldin der Welt",
        gsw: "Die chlinst Superheldin vo de Wält",
        fr: "La Plus Petite Super-Héroïne du Monde",
        it: "La Più Piccola Supereroina del Mondo"
      }
    },
    detective: {
      male: {
        en: "The Case of the Missing Treasure",
        de: "Der Fall des verschwundenen Schatzes",
        gsw: "De Fall vom verschwundne Schatz",
        fr: "L'Affaire du Trésor Disparu",
        it: "Il Caso del Tesoro Scomparso"
      },
      female: {
        en: "The Case of the Missing Treasure",
        de: "Der Fall des verschwundenen Schatzes",
        gsw: "De Fall vom verschwundne Schatz",
        fr: "L'Affaire du Trésor Disparu",
        it: "Il Caso del Tesoro Scomparso"
      }
    },
    unicorn: {
      male: {
        en: "The Rainbow Unicorn's Magical Journey",
        de: "Die magische Reise des Regenbogen-Einhorns",
        gsw: "Die magischi Reis vom Rägeboge-Eihorn",
        fr: "Le Voyage Magique de la Licorne Arc-en-Ciel",
        it: "Il Viaggio Magico dell'Unicorno Arcobaleno"
      },
      female: {
        en: "The Rainbow Unicorn's Magical Journey",
        de: "Die magische Reise des Regenbogen-Einhorns",
        gsw: "Die magischi Reis vom Rägeboge-Eihorn",
        fr: "Le Voyage Magique de la Licorne Arc-en-Ciel",
        it: "Il Viaggio Magico dell'Unicorno Arcobaleno"
      }
    },
    mermaid: {
      male: {
        en: "Secrets Beneath the Waves",
        de: "Geheimnisse unter den Wellen",
        gsw: "Gheimnisse under de Wälle",
        fr: "Secrets sous les Vagues",
        it: "Segreti sotto le Onde"
      },
      female: {
        en: "Secrets Beneath the Waves",
        de: "Geheimnisse unter den Wellen",
        gsw: "Gheimnisse under de Wälle",
        fr: "Secrets sous les Vagues",
        it: "Segreti sotto le Onde"
      }
    },
    dinosaur: {
      male: {
        en: "The Land Before Time Forgot",
        de: "Das Land, das die Zeit vergass",
        gsw: "S Land, wo d Zit vergässe het",
        fr: "Le Pays que le Temps a Oublié",
        it: "La Terra che il Tempo ha Dimenticato"
      },
      female: {
        en: "The Land Before Time Forgot",
        de: "Das Land, das die Zeit vergass",
        gsw: "S Land, wo d Zit vergässe het",
        fr: "Le Pays que le Temps a Oublié",
        it: "La Terra che il Tempo ha Dimenticato"
      }
    },
    space: {
      male: {
        en: "Mission to the Stars",
        de: "Mission zu den Sternen",
        gsw: "Mission zu de Stärne",
        fr: "Mission vers les Étoiles",
        it: "Missione verso le Stelle"
      },
      female: {
        en: "Mission to the Stars",
        de: "Mission zu den Sternen",
        gsw: "Mission zu de Stärne",
        fr: "Mission vers les Étoiles",
        it: "Missione verso le Stelle"
      }
    },
    ocean: {
      male: {
        en: "The Deep Blue Sea Adventure",
        de: "Abenteuer in der Tiefsee",
        gsw: "Abentüür in de Tüüfsee",
        fr: "L'Aventure des Profondeurs Marines",
        it: "L'Avventura negli Abissi Marini"
      },
      female: {
        en: "The Deep Blue Sea Adventure",
        de: "Abenteuer in der Tiefsee",
        gsw: "Abentüür in de Tüüfsee",
        fr: "L'Aventure des Profondeurs Marines",
        it: "L'Avventura negli Abissi Marini"
      }
    },
    jungle: {
      male: {
        en: "Through the Wild Jungle",
        de: "Durch den wilden Dschungel",
        gsw: "Dur de wild Dschungel",
        fr: "À Travers la Jungle Sauvage",
        it: "Attraverso la Giungla Selvaggia"
      },
      female: {
        en: "Through the Wild Jungle",
        de: "Durch den wilden Dschungel",
        gsw: "Dur de wild Dschungel",
        fr: "À Travers la Jungle Sauvage",
        it: "Attraverso la Giungla Selvaggia"
      }
    },
    farm: {
      male: {
        en: "A Wonderful Day on the Farm",
        de: "Ein wunderbarer Tag auf dem Bauernhof",
        gsw: "En wunderbari Tag uf em Burehof",
        fr: "Une Journée Merveilleuse à la Ferme",
        it: "Una Giornata Meravigliosa alla Fattoria"
      },
      female: {
        en: "A Wonderful Day on the Farm",
        de: "Ein wunderbarer Tag auf dem Bauernhof",
        gsw: "En wunderbari Tag uf em Burehof",
        fr: "Une Journée Merveilleuse à la Ferme",
        it: "Una Giornata Meravigliosa alla Fattoria"
      }
    },
    forest: {
      male: {
        en: "The Enchanted Forest Quest",
        de: "Die Suche im verzauberten Wald",
        gsw: "D Suechi im verzauberte Wald",
        fr: "La Quête de la Forêt Enchantée",
        it: "La Ricerca nella Foresta Incantata"
      },
      female: {
        en: "The Enchanted Forest Quest",
        de: "Die Suche im verzauberten Wald",
        gsw: "D Suechi im verzauberte Wald",
        fr: "La Quête de la Forêt Enchantée",
        it: "La Ricerca nella Foresta Incantata"
      }
    },
    fireman: {
      male: {
        en: "The Brave Little Firefighter",
        de: "Der mutige kleine Feuerwehrmann",
        gsw: "De muetig chli Füürwehrma",
        fr: "Le Petit Pompier Courageux",
        it: "Il Piccolo Pompiere Coraggioso"
      },
      female: {
        en: "The Brave Little Firefighter",
        de: "Die mutige kleine Feuerwehrfrau",
        gsw: "Die muetig chli Füürwehrfrau",
        fr: "La Petite Pompière Courageuse",
        it: "La Piccola Pompiera Coraggiosa"
      }
    },
    doctor: {
      male: {
        en: "The Little Doctor's Big Day",
        de: "Der grosse Tag des kleinen Doktors",
        gsw: "De gross Tag vom chline Dokter",
        fr: "La Grande Journée du Petit Docteur",
        it: "Il Grande Giorno del Piccolo Dottore"
      },
      female: {
        en: "The Little Doctor's Big Day",
        de: "Der grosse Tag der kleinen Doktorin",
        gsw: "De gross Tag vo de chline Doktorin",
        fr: "La Grande Journée de la Petite Docteure",
        it: "Il Grande Giorno della Piccola Dottoressa"
      }
    },
    police: {
      male: {
        en: "On Patrol — A Police Adventure",
        de: "Auf Streife — Ein Polizei-Abenteuer",
        gsw: "Uf Streifi — Es Polizei-Abentüür",
        fr: "En Patrouille — Une Aventure de Police",
        it: "In Pattuglia — Un'Avventura della Polizia"
      },
      female: {
        en: "On Patrol — A Police Adventure",
        de: "Auf Streife — Ein Polizei-Abenteuer",
        gsw: "Uf Streifi — Es Polizei-Abentüür",
        fr: "En Patrouille — Une Aventure de Police",
        it: "In Pattuglia — Un'Avventura della Polizia"
      }
    },
    christmas: {
      male: {
        en: "The Most Magical Christmas Eve",
        de: "Der zauberhafteste Heiligabend",
        gsw: "De zauberhaftist Heiligabe",
        fr: "Le Réveillon de Noël le Plus Magique",
        it: "La Vigilia di Natale Più Magica"
      },
      female: {
        en: "The Most Magical Christmas Eve",
        de: "Der zauberhafteste Heiligabend",
        gsw: "De zauberhaftist Heiligabe",
        fr: "Le Réveillon de Noël le Plus Magique",
        it: "La Vigilia di Natale Più Magica"
      }
    },
    newyear: {
      male: {
        en: "The Midnight New Year's Surprise",
        de: "Die Mitternachts-Überraschung an Silvester",
        gsw: "D Mitternachts-Überraschig a Silveschter",
        fr: "La Surprise de Minuit du Nouvel An",
        it: "La Sorpresa di Mezzanotte di Capodanno"
      },
      female: {
        en: "The Midnight New Year's Surprise",
        de: "Die Mitternachts-Überraschung an Silvester",
        gsw: "D Mitternachts-Überraschig a Silveschter",
        fr: "La Surprise de Minuit du Nouvel An",
        it: "La Sorpresa di Mezzanotte di Capodanno"
      }
    },
    easter: {
      male: {
        en: "The Great Easter Egg Hunt",
        de: "Die grosse Ostereier-Suche",
        gsw: "Die gross Oschtereier-Suechi",
        fr: "La Grande Chasse aux Œufs de Pâques",
        it: "La Grande Caccia alle Uova di Pasqua"
      },
      female: {
        en: "The Great Easter Egg Hunt",
        de: "Die grosse Ostereier-Suche",
        gsw: "Die gross Oschtereier-Suechi",
        fr: "La Grande Chasse aux Œufs de Pâques",
        it: "La Grande Caccia alle Uova di Pasqua"
      }
    },
    halloween: {
      male: {
        en: "The Spooky Halloween Night",
        de: "Die gruselige Halloween-Nacht",
        gsw: "Die grusigi Halloween-Nacht",
        fr: "La Nuit d'Halloween Frissonnante",
        it: "La Notte di Halloween da Brivido"
      },
      female: {
        en: "The Spooky Halloween Night",
        de: "Die gruselige Halloween-Nacht",
        gsw: "Die grusigi Halloween-Nacht",
        fr: "La Nuit d'Halloween Frissonnante",
        it: "La Notte di Halloween da Brivido"
      }
    }
  },

  // ══════════════════════════════════════════════════════════════
  // HISTORICAL EVENTS
  // ══════════════════════════════════════════════════════════════
  historical: {
    // ── Swiss History ──────────────────────────────────────────────
    'swiss-founding': {
      male: {
        en: "The Secret of the Swiss Mountains",
        de: "Das Geheimnis der Schweizer Berge",
        gsw: "S Gheimnis vo de Schwizer Bärge",
        fr: "Le Secret des Montagnes Suisses",
        it: "Il Segreto delle Montagne Svizzere"
      },
      female: {
        en: "The Secret of the Swiss Mountains",
        de: "Das Geheimnis der Schweizer Berge",
        gsw: "S Gheimnis vo de Schwizer Bärge",
        fr: "Le Secret des Montagnes Suisses",
        it: "Il Segreto delle Montagne Svizzere"
      }
    },
    'wilhelm-tell': {
      male: {
        en: "The Boy Who Never Missed",
        de: "Der Junge, der nie daneben schoss",
        gsw: "De Bueb, wo nie dänäbe gschosse het",
        fr: "Le Garçon Qui Ne Manquait Jamais",
        it: "Il Ragazzo Che Non Mancava Mai"
      },
      female: {
        en: "The Girl Who Never Missed",
        de: "Das Mädchen, das nie daneben schoss",
        gsw: "S Meitli, wo nie dänäbe gschosse het",
        fr: "La Fille Qui Ne Manquait Jamais",
        it: "La Ragazza Che Non Mancava Mai"
      }
    },
    'battle-morgarten': {
      male: {
        en: "Thunder on the Mountain Pass",
        de: "Donner am Bergpass",
        gsw: "Donner am Bärgpass",
        fr: "Tonnerre sur le Col de Montagne",
        it: "Tuono sul Passo di Montagna"
      },
      female: {
        en: "Thunder on the Mountain Pass",
        de: "Donner am Bergpass",
        gsw: "Donner am Bärgpass",
        fr: "Tonnerre sur le Col de Montagne",
        it: "Tuono sul Passo di Montagna"
      }
    },
    'battle-sempach': {
      male: {
        en: "The Brave Hearts of Sempach",
        de: "Die tapferen Herzen von Sempach",
        gsw: "Die tapfere Härze vo Sempach",
        fr: "Les Coeurs Vaillants de Sempach",
        it: "I Cuori Coraggiosi di Sempach"
      },
      female: {
        en: "The Brave Hearts of Sempach",
        de: "Die tapferen Herzen von Sempach",
        gsw: "Die tapfere Härze vo Sempach",
        fr: "Les Coeurs Vaillants de Sempach",
        it: "I Cuori Coraggiosi di Sempach"
      }
    },
    'swiss-reformation': {
      male: {
        en: "The Boy with the Forbidden Book",
        de: "Der Junge mit dem verbotenen Buch",
        gsw: "De Bueb mit em verbotene Buech",
        fr: "Le Garçon au Livre Interdit",
        it: "Il Ragazzo con il Libro Proibito"
      },
      female: {
        en: "The Girl with the Forbidden Book",
        de: "Das Mädchen mit dem verbotenen Buch",
        gsw: "S Meitli mit em verbotene Buech",
        fr: "La Fille au Livre Interdit",
        it: "La Ragazza con il Libro Proibito"
      }
    },
    'red-cross-founding': {
      male: {
        en: "The Little Helper of Solferino",
        de: "Der kleine Helfer von Solferino",
        gsw: "De chli Hälfer vo Solferino",
        fr: "Le Petit Secouriste de Solférino",
        it: "Il Piccolo Soccorritore di Solferino"
      },
      female: {
        en: "The Little Helper of Solferino",
        de: "Die kleine Helferin von Solferino",
        gsw: "S chli Hälferi vo Solferino",
        fr: "La Petite Secouriste de Solférino",
        it: "La Piccola Soccorritrice di Solferino"
      }
    },
    'general-dufour': {
      male: {
        en: "The Mapmaker's Great Adventure",
        de: "Das grosse Abenteuer des Kartografen",
        gsw: "S grosse Abentüür vom Chartograf",
        fr: "La Grande Aventure du Cartographe",
        it: "La Grande Avventura del Cartografo"
      },
      female: {
        en: "The Mapmaker's Great Adventure",
        de: "Das grosse Abenteuer der Kartografin",
        gsw: "S grosse Abentüür vo de Chartografin",
        fr: "La Grande Aventure de la Cartographe",
        it: "La Grande Avventura della Cartografa"
      }
    },
    'sonderbund-war': {
      male: {
        en: "The Boy Who United a Nation",
        de: "Der Junge, der ein Land vereinte",
        gsw: "De Bueb, wo es Land vereint het",
        fr: "Le Garçon Qui Unifia un Pays",
        it: "Il Ragazzo Che Unì una Nazione"
      },
      female: {
        en: "The Girl Who United a Nation",
        de: "Das Mädchen, das ein Land vereinte",
        gsw: "S Meitli, wo es Land vereint het",
        fr: "La Fille Qui Unifia un Pays",
        it: "La Ragazza Che Unì una Nazione"
      }
    },
    'swiss-constitution': {
      male: {
        en: "The Promise of the Parchment",
        de: "Das Versprechen auf dem Pergament",
        gsw: "S Verspräche uf em Pergamänt",
        fr: "La Promesse du Parchemin",
        it: "La Promessa della Pergamena"
      },
      female: {
        en: "The Promise of the Parchment",
        de: "Das Versprechen auf dem Pergament",
        gsw: "S Verspräche uf em Pergamänt",
        fr: "La Promesse du Parchemin",
        it: "La Promessa della Pergamena"
      }
    },
    'gotthard-tunnel': {
      male: {
        en: "Digging Through the Mountain",
        de: "Der Tunnel durch den Berg",
        gsw: "De Tunnel dure Berg",
        fr: "Le Tunnel à Travers la Montagne",
        it: "Il Tunnel Attraverso la Montagna"
      },
      female: {
        en: "Digging Through the Mountain",
        de: "Der Tunnel durch den Berg",
        gsw: "De Tunnel dure Berg",
        fr: "Le Tunnel à Travers la Montagne",
        it: "Il Tunnel Attraverso la Montagna"
      }
    },
    'swiss-ww1-neutrality': {
      male: {
        en: "The Lighthouse Between the Storms",
        de: "Der Leuchtturm zwischen den Stürmen",
        gsw: "De Lüüchtturm zwüsche de Stürm",
        fr: "Le Phare Entre les Tempêtes",
        it: "Il Faro Tra le Tempeste"
      },
      female: {
        en: "The Lighthouse Between the Storms",
        de: "Der Leuchtturm zwischen den Stürmen",
        gsw: "De Lüüchtturm zwüsche de Stürm",
        fr: "Le Phare Entre les Tempêtes",
        it: "Il Faro Tra le Tempeste"
      }
    },
    'general-guisan': {
      male: {
        en: "The Guardian of the Alps",
        de: "Der Wächter der Alpen",
        gsw: "De Wächter vo de Alpe",
        fr: "Le Gardien des Alpes",
        it: "Il Guardiano delle Alpi"
      },
      female: {
        en: "The Guardian of the Alps",
        de: "Die Wächterin der Alpen",
        gsw: "D Wächterin vo de Alpe",
        fr: "La Gardienne des Alpes",
        it: "La Guardiana delle Alpi"
      }
    },
    'swiss-ww2-neutrality': {
      male: {
        en: "The Brave Little Country",
        de: "Das mutige kleine Land",
        gsw: "S muetige chline Land",
        fr: "Le Petit Pays Courageux",
        it: "Il Piccolo Paese Coraggioso"
      },
      female: {
        en: "The Brave Little Country",
        de: "Das mutige kleine Land",
        gsw: "S muetige chline Land",
        fr: "Le Petit Pays Courageux",
        it: "Il Piccolo Paese Coraggioso"
      }
    },
    'swiss-womens-vote': {
      male: {
        en: "The Day Every Voice Counted",
        de: "Der Tag, an dem jede Stimme zählte",
        gsw: "De Tag, wo jedi Stimm zellt het",
        fr: "Le Jour Où Chaque Voix a Compté",
        it: "Il Giorno in Cui Ogni Voce Contò"
      },
      female: {
        en: "The Day Every Voice Counted",
        de: "Der Tag, an dem jede Stimme zählte",
        gsw: "De Tag, wo jedi Stimm zellt het",
        fr: "Le Jour Où Chaque Voix a Compté",
        it: "Il Giorno in Cui Ogni Voce Contò"
      }
    },

    // ── Exploration & Discovery ────────────────────────────────────
    'moon-landing': {
      male: {
        en: "One Small Step for a Big Dream",
        de: "Ein kleiner Schritt für einen grossen Traum",
        gsw: "Es chlises Schrittli für en grosse Traum",
        fr: "Un Petit Pas pour un Grand Rêve",
        it: "Un Piccolo Passo per un Grande Sogno"
      },
      female: {
        en: "One Small Step for a Big Dream",
        de: "Ein kleiner Schritt für einen grossen Traum",
        gsw: "Es chlises Schrittli für en grosse Traum",
        fr: "Un Petit Pas pour un Grand Rêve",
        it: "Un Piccolo Passo per un Grande Sogno"
      }
    },
    'columbus-voyage': {
      male: {
        en: "Sailing Beyond the Edge of the World",
        de: "Segeln über den Rand der Welt",
        gsw: "Segle über de Rand vo de Wält",
        fr: "Naviguer Au-delà du Bout du Monde",
        it: "Navigare Oltre il Confine del Mondo"
      },
      female: {
        en: "Sailing Beyond the Edge of the World",
        de: "Segeln über den Rand der Welt",
        gsw: "Segle über de Rand vo de Wält",
        fr: "Naviguer Au-delà du Bout du Monde",
        it: "Navigare Oltre il Confine del Mondo"
      }
    },
    'wright-brothers': {
      male: {
        en: "The Boy Who Learned to Fly",
        de: "Der Junge, der fliegen lernte",
        gsw: "De Bueb, wo flüge glehrt het",
        fr: "Le Garçon Qui Apprit à Voler",
        it: "Il Ragazzo Che Imparò a Volare"
      },
      female: {
        en: "The Girl Who Learned to Fly",
        de: "Das Mädchen, das fliegen lernte",
        gsw: "S Meitli, wo flüge glehrt het",
        fr: "La Fille Qui Apprit à Voler",
        it: "La Ragazza Che Imparò a Volare"
      }
    },
    'lindbergh-flight': {
      male: {
        en: "Alone Above the Ocean",
        de: "Allein über dem Ozean",
        gsw: "Elei über em Ozean",
        fr: "Seul Au-dessus de l'Océan",
        it: "Solo Sopra l'Oceano"
      },
      female: {
        en: "Alone Above the Ocean",
        de: "Allein über dem Ozean",
        gsw: "Elei über em Ozean",
        fr: "Seule Au-dessus de l'Océan",
        it: "Sola Sopra l'Oceano"
      }
    },
    'everest-summit': {
      male: {
        en: "The Top of the World",
        de: "Auf dem Dach der Welt",
        gsw: "Uf em Dach vo de Wält",
        fr: "Le Sommet du Monde",
        it: "La Cima del Mondo"
      },
      female: {
        en: "The Top of the World",
        de: "Auf dem Dach der Welt",
        gsw: "Uf em Dach vo de Wält",
        fr: "Le Sommet du Monde",
        it: "La Cima del Mondo"
      }
    },
    'south-pole': {
      male: {
        en: "Race to the Frozen End of the Earth",
        de: "Wettlauf zum gefrorenen Ende der Welt",
        gsw: "Wettlouf zum gfrorene Ändi vo de Wält",
        fr: "La Course Vers le Bout Gelé du Monde",
        it: "La Corsa Verso la Fine Ghiacciata del Mondo"
      },
      female: {
        en: "Race to the Frozen End of the Earth",
        de: "Wettlauf zum gefrorenen Ende der Welt",
        gsw: "Wettlouf zum gfrorene Ändi vo de Wält",
        fr: "La Course Vers le Bout Gelé du Monde",
        it: "La Corsa Verso la Fine Ghiacciata del Mondo"
      }
    },
    'magellan-circumnavigation': {
      male: {
        en: "All the Way Around the World",
        de: "Einmal um die ganze Welt",
        gsw: "Einisch um die ganzi Wält",
        fr: "Le Tour du Monde Entier",
        it: "Il Giro di Tutto il Mondo"
      },
      female: {
        en: "All the Way Around the World",
        de: "Einmal um die ganze Welt",
        gsw: "Einisch um die ganzi Wält",
        fr: "Le Tour du Monde Entier",
        it: "Il Giro di Tutto il Mondo"
      }
    },
    'mariana-trench': {
      male: {
        en: "Journey to the Deepest Deep",
        de: "Reise in die tiefste Tiefe",
        gsw: "Reis i die tüüfschti Tüüfi",
        fr: "Voyage au Plus Profond des Abysses",
        it: "Viaggio nel Più Profondo degli Abissi"
      },
      female: {
        en: "Journey to the Deepest Deep",
        de: "Reise in die tiefste Tiefe",
        gsw: "Reis i die tüüfschti Tüüfi",
        fr: "Voyage au Plus Profond des Abysses",
        it: "Viaggio nel Più Profondo degli Abissi"
      }
    },

    // ── Science & Medicine ─────────────────────────────────────────
    'electricity-discovery': {
      male: {
        en: "The Boy Who Caught Lightning",
        de: "Der Junge, der den Blitz fing",
        gsw: "De Bueb, wo de Blitz gfange het",
        fr: "Le Garçon Qui Attrapa la Foudre",
        it: "Il Ragazzo Che Catturò il Fulmine"
      },
      female: {
        en: "The Girl Who Caught Lightning",
        de: "Das Mädchen, das den Blitz fing",
        gsw: "S Meitli, wo de Blitz gfange het",
        fr: "La Fille Qui Attrapa la Foudre",
        it: "La Ragazza Che Catturò il Fulmine"
      }
    },
    'penicillin': {
      male: {
        en: "The Magical Mould",
        de: "Der wunderbare Schimmelpilz",
        gsw: "De wunderbar Schimmelpilz",
        fr: "La Moisissure Magique",
        it: "La Muffa Magica"
      },
      female: {
        en: "The Magical Mould",
        de: "Der wunderbare Schimmelpilz",
        gsw: "De wunderbar Schimmelpilz",
        fr: "La Moisissure Magique",
        it: "La Muffa Magica"
      }
    },
    'vaccine-discovery': {
      male: {
        en: "The Doctor and the Milkmaid's Secret",
        de: "Der Arzt und das Geheimnis der Magd",
        gsw: "De Dokter und s Gheimnis vo de Magd",
        fr: "Le Médecin et le Secret de la Laitière",
        it: "Il Dottore e il Segreto della Lattaia"
      },
      female: {
        en: "The Doctor and the Milkmaid's Secret",
        de: "Die Ärztin und das Geheimnis der Magd",
        gsw: "D Dokterin und s Gheimnis vo de Magd",
        fr: "La Médecin et le Secret de la Laitière",
        it: "La Dottoressa e il Segreto della Lattaia"
      }
    },
    'dna-discovery': {
      male: {
        en: "The Invisible Code of Life",
        de: "Der unsichtbare Code des Lebens",
        gsw: "De unsichtbar Code vom Läbe",
        fr: "Le Code Invisible de la Vie",
        it: "Il Codice Invisibile della Vita"
      },
      female: {
        en: "The Invisible Code of Life",
        de: "Der unsichtbare Code des Lebens",
        gsw: "De unsichtbar Code vom Läbe",
        fr: "Le Code Invisible de la Vie",
        it: "Il Codice Invisibile della Vita"
      }
    },
    'dinosaur-discovery': {
      male: {
        en: "The Boy Who Found the Dragon Bones",
        de: "Der Junge, der die Drachenknochen fand",
        gsw: "De Bueb, wo d Drachechnoche gfunde het",
        fr: "Le Garçon Qui Trouva les Os du Dragon",
        it: "Il Ragazzo Che Trovò le Ossa del Drago"
      },
      female: {
        en: "The Girl Who Found the Dragon Bones",
        de: "Das Mädchen, das die Drachenknochen fand",
        gsw: "S Meitli, wo d Drachechnoche gfunde het",
        fr: "La Fille Qui Trouva les Os du Dragon",
        it: "La Ragazza Che Trovò le Ossa del Drago"
      }
    },
    'einstein-relativity': {
      male: {
        en: "The Boy Who Raced a Beam of Light",
        de: "Der Junge, der mit dem Licht um die Wette lief",
        gsw: "De Bueb, wo mit em Liecht um d Wett grannt isch",
        fr: "Le Garçon Qui Fit la Course avec la Lumière",
        it: "Il Ragazzo Che Gareggiò con un Raggio di Luce"
      },
      female: {
        en: "The Girl Who Raced a Beam of Light",
        de: "Das Mädchen, das mit dem Licht um die Wette lief",
        gsw: "S Meitli, wo mit em Liecht um d Wett grannt isch",
        fr: "La Fille Qui Fit la Course avec la Lumière",
        it: "La Ragazza Che Gareggiò con un Raggio di Luce"
      }
    },
    'galapagos-darwin': {
      male: {
        en: "The Island of Extraordinary Animals",
        de: "Die Insel der wundersamen Tiere",
        gsw: "D Insle vo de wundersame Tier",
        fr: "L'Île des Animaux Extraordinaires",
        it: "L'Isola degli Animali Straordinari"
      },
      female: {
        en: "The Island of Extraordinary Animals",
        de: "Die Insel der wundersamen Tiere",
        gsw: "D Insle vo de wundersame Tier",
        fr: "L'Île des Animaux Extraordinaires",
        it: "L'Isola degli Animali Straordinari"
      }
    },
    'first-heart-transplant': {
      male: {
        en: "The Doctor with the Bravest Hands",
        de: "Der Arzt mit den mutigsten Händen",
        gsw: "De Dokter mit de muetigste Händ",
        fr: "Le Médecin aux Mains les Plus Courageuses",
        it: "Il Dottore con le Mani Più Coraggiose"
      },
      female: {
        en: "The Doctor with the Bravest Hands",
        de: "Die Ärztin mit den mutigsten Händen",
        gsw: "D Dokterin mit de muetigste Händ",
        fr: "La Médecin aux Mains les Plus Courageuses",
        it: "La Dottoressa con le Mani Più Coraggiose"
      }
    },
    'human-genome': {
      male: {
        en: "The Treasure Map Inside You",
        de: "Die Schatzkarte in dir",
        gsw: "D Schatzchart i dir",
        fr: "La Carte au Trésor Cachée en Toi",
        it: "La Mappa del Tesoro Dentro di Te"
      },
      female: {
        en: "The Treasure Map Inside You",
        de: "Die Schatzkarte in dir",
        gsw: "D Schatzchart i dir",
        fr: "La Carte au Trésor Cachée en Toi",
        it: "La Mappa del Tesoro Dentro di Te"
      }
    },
    'hubble-launch': {
      male: {
        en: "The Eye That Sees Forever",
        de: "Das Auge, das bis in die Unendlichkeit sieht",
        gsw: "S Aug, wo bis i d Unändlichkeit gseht",
        fr: "L'Oeil Qui Voit l'Infini",
        it: "L'Occhio Che Vede l'Infinito"
      },
      female: {
        en: "The Eye That Sees Forever",
        de: "Das Auge, das bis in die Unendlichkeit sieht",
        gsw: "S Aug, wo bis i d Unändlichkeit gseht",
        fr: "L'Oeil Qui Voit l'Infini",
        it: "L'Occhio Che Vede l'Infinito"
      }
    },

    // ── Inventions ─────────────────────────────────────────────────
    'telephone-invention': {
      male: {
        en: "The Wire That Could Whisper",
        de: "Der Draht, der flüstern konnte",
        gsw: "De Draht, wo het chöne flüstere",
        fr: "Le Fil Qui Savait Chuchoter",
        it: "Il Filo Che Sapeva Sussurrare"
      },
      female: {
        en: "The Wire That Could Whisper",
        de: "Der Draht, der flüstern konnte",
        gsw: "De Draht, wo het chöne flüstere",
        fr: "Le Fil Qui Savait Chuchoter",
        it: "Il Filo Che Sapeva Sussurrare"
      }
    },
    'light-bulb': {
      male: {
        en: "The Boy Who Lit Up the Night",
        de: "Der Junge, der die Nacht erleuchtete",
        gsw: "De Bueb, wo d Nacht erlüchtet het",
        fr: "Le Garçon Qui Illumina la Nuit",
        it: "Il Ragazzo Che Illuminò la Notte"
      },
      female: {
        en: "The Girl Who Lit Up the Night",
        de: "Das Mädchen, das die Nacht erleuchtete",
        gsw: "S Meitli, wo d Nacht erlüchtet het",
        fr: "La Fille Qui Illumina la Nuit",
        it: "La Ragazza Che Illuminò la Notte"
      }
    },
    'printing-press': {
      male: {
        en: "The Machine That Made Words Fly",
        de: "Die Maschine, die Wörter fliegen liess",
        gsw: "D Maschine, wo d Wörter het la flüge",
        fr: "La Machine Qui Faisait Voler les Mots",
        it: "La Macchina Che Faceva Volare le Parole"
      },
      female: {
        en: "The Machine That Made Words Fly",
        de: "Die Maschine, die Wörter fliegen liess",
        gsw: "D Maschine, wo d Wörter het la flüge",
        fr: "La Machine Qui Faisait Voler les Mots",
        it: "La Macchina Che Faceva Volare le Parole"
      }
    },
    'internet-creation': {
      male: {
        en: "The Invisible Web That Connected the World",
        de: "Das unsichtbare Netz, das die Welt verband",
        gsw: "S unsichtbare Netz, wo d Wält verbunde het",
        fr: "La Toile Invisible Qui Relia le Monde",
        it: "La Rete Invisibile Che Collegò il Mondo"
      },
      female: {
        en: "The Invisible Web That Connected the World",
        de: "Das unsichtbare Netz, das die Welt verband",
        gsw: "S unsichtbare Netz, wo d Wält verbunde het",
        fr: "La Toile Invisible Qui Relia le Monde",
        it: "La Rete Invisibile Che Collegò il Mondo"
      }
    },

    // ── Human Rights & Freedom ─────────────────────────────────────
    'emancipation': {
      male: {
        en: "The Day the Chains Broke",
        de: "Der Tag, an dem die Ketten brachen",
        gsw: "De Tag, wo d Chette broche sind",
        fr: "Le Jour Où les Chaînes se Brisèrent",
        it: "Il Giorno in Cui le Catene si Spezzarono"
      },
      female: {
        en: "The Day the Chains Broke",
        de: "Der Tag, an dem die Ketten brachen",
        gsw: "De Tag, wo d Chette broche sind",
        fr: "Le Jour Où les Chaînes se Brisèrent",
        it: "Il Giorno in Cui le Catene si Spezzarono"
      }
    },
    'womens-suffrage': {
      male: {
        en: "The March for a Million Voices",
        de: "Der Marsch für eine Million Stimmen",
        gsw: "De Marsch für e Million Stimme",
        fr: "La Marche pour un Million de Voix",
        it: "La Marcia per un Milione di Voci"
      },
      female: {
        en: "The March for a Million Voices",
        de: "Der Marsch für eine Million Stimmen",
        gsw: "De Marsch für e Million Stimme",
        fr: "La Marche pour un Million de Voix",
        it: "La Marcia per un Milione di Voci"
      }
    },
    'rosa-parks': {
      male: {
        en: "The Seat That Changed the World",
        de: "Der Sitzplatz, der die Welt veränderte",
        gsw: "De Sitzplatz, wo d Wält veränderet het",
        fr: "Le Siège Qui Changea le Monde",
        it: "Il Posto Che Cambiò il Mondo"
      },
      female: {
        en: "The Seat That Changed the World",
        de: "Der Sitzplatz, der die Welt veränderte",
        gsw: "De Sitzplatz, wo d Wält veränderet het",
        fr: "Le Siège Qui Changea le Monde",
        it: "Il Posto Che Cambiò il Mondo"
      }
    },
    'berlin-wall-fall': {
      male: {
        en: "The Night the Wall Came Down",
        de: "Die Nacht, als die Mauer fiel",
        gsw: "D Nacht, wo d Muur gfalle isch",
        fr: "La Nuit Où le Mur est Tombé",
        it: "La Notte in Cui il Muro Cadde"
      },
      female: {
        en: "The Night the Wall Came Down",
        de: "Die Nacht, als die Mauer fiel",
        gsw: "D Nacht, wo d Muur gfalle isch",
        fr: "La Nuit Où le Mur est Tombé",
        it: "La Notte in Cui il Muro Cadde"
      }
    },
    'mandela-freedom': {
      male: {
        en: "The Long Walk to Freedom",
        de: "Der lange Weg zur Freiheit",
        gsw: "De lang Wäg zur Freiheit",
        fr: "La Longue Marche Vers la Liberté",
        it: "La Lunga Strada Verso la Libertà"
      },
      female: {
        en: "The Long Walk to Freedom",
        de: "Der lange Weg zur Freiheit",
        gsw: "De lang Wäg zur Freiheit",
        fr: "La Longue Marche Vers la Liberté",
        it: "La Lunga Strada Verso la Libertà"
      }
    },

    // ── Great Constructions ────────────────────────────────────────
    'pyramids': {
      male: {
        en: "The Boy Who Touched the Sky with Stones",
        de: "Der Junge, der mit Steinen den Himmel berührte",
        gsw: "De Bueb, wo mit Stei de Himmel berüehrt het",
        fr: "Le Garçon Qui Toucha le Ciel avec des Pierres",
        it: "Il Ragazzo Che Toccò il Cielo con le Pietre"
      },
      female: {
        en: "The Girl Who Touched the Sky with Stones",
        de: "Das Mädchen, das mit Steinen den Himmel berührte",
        gsw: "S Meitli, wo mit Stei de Himmel berüehrt het",
        fr: "La Fille Qui Toucha le Ciel avec des Pierres",
        it: "La Ragazza Che Toccò il Cielo con le Pietre"
      }
    },
    'eiffel-tower': {
      male: {
        en: "The Iron Giant of Paris",
        de: "Der Eisenriese von Paris",
        gsw: "De Iiseriis vo Paris",
        fr: "Le Géant de Fer de Paris",
        it: "Il Gigante di Ferro di Parigi"
      },
      female: {
        en: "The Iron Giant of Paris",
        de: "Der Eisenriese von Paris",
        gsw: "De Iiseriis vo Paris",
        fr: "Le Géant de Fer de Paris",
        it: "Il Gigante di Ferro di Parigi"
      }
    },
    'panama-canal': {
      male: {
        en: "The River Between Two Oceans",
        de: "Der Fluss zwischen zwei Ozeanen",
        gsw: "De Fluss zwüsche zwöi Ozeane",
        fr: "La Rivière Entre Deux Océans",
        it: "Il Fiume Tra Due Oceani"
      },
      female: {
        en: "The River Between Two Oceans",
        de: "Der Fluss zwischen zwei Ozeanen",
        gsw: "De Fluss zwüsche zwöi Ozeane",
        fr: "La Rivière Entre Deux Océans",
        it: "Il Fiume Tra Due Oceani"
      }
    },
    'golden-gate': {
      male: {
        en: "The Bridge Above the Fog",
        de: "Die Brücke über dem Nebel",
        gsw: "D Brugg über em Näbel",
        fr: "Le Pont Au-dessus du Brouillard",
        it: "Il Ponte Sopra la Nebbia"
      },
      female: {
        en: "The Bridge Above the Fog",
        de: "Die Brücke über dem Nebel",
        gsw: "D Brugg über em Näbel",
        fr: "Le Pont Au-dessus du Brouillard",
        it: "Il Ponte Sopra la Nebbia"
      }
    },
    'channel-tunnel': {
      male: {
        en: "The Tunnel Under the Sea",
        de: "Der Tunnel unter dem Meer",
        gsw: "De Tunnel unterm Meer",
        fr: "Le Tunnel Sous la Mer",
        it: "Il Tunnel Sotto il Mare"
      },
      female: {
        en: "The Tunnel Under the Sea",
        de: "Der Tunnel unter dem Meer",
        gsw: "De Tunnel unterm Meer",
        fr: "Le Tunnel Sous la Mer",
        it: "Il Tunnel Sotto il Mare"
      }
    },

    // ── Culture & Arts ─────────────────────────────────────────────
    'first-olympics': {
      male: {
        en: "The Fastest Boy in Ancient Greece",
        de: "Der schnellste Junge im alten Griechenland",
        gsw: "De schnällscht Bueb im alte Griecheland",
        fr: "Le Garçon le Plus Rapide de la Grèce Antique",
        it: "Il Ragazzo Più Veloce dell'Antica Grecia"
      },
      female: {
        en: "The Fastest Girl in Ancient Greece",
        de: "Das schnellste Mädchen im alten Griechenland",
        gsw: "S schnällschte Meitli im alte Griecheland",
        fr: "La Fille la Plus Rapide de la Grèce Antique",
        it: "La Ragazza Più Veloce dell'Antica Grecia"
      }
    },
    'disneyland-opening': {
      male: {
        en: "The Day the Dream Park Opened",
        de: "Der Tag, als der Traumpark öffnete",
        gsw: "De Tag, wo de Traumpark ufgmacht het",
        fr: "Le Jour Où le Parc des Rêves a Ouvert",
        it: "Il Giorno in Cui il Parco dei Sogni Aprì"
      },
      female: {
        en: "The Day the Dream Park Opened",
        de: "Der Tag, als der Traumpark öffnete",
        gsw: "De Tag, wo de Traumpark ufgmacht het",
        fr: "Le Jour Où le Parc des Rêves a Ouvert",
        it: "Il Giorno in Cui il Parco dei Sogni Aprì"
      }
    },
    'first-movie': {
      male: {
        en: "The Night the Pictures Came Alive",
        de: "Die Nacht, in der die Bilder lebendig wurden",
        gsw: "D Nacht, wo d Bilder läbendig worde sind",
        fr: "La Nuit Où les Images Prirent Vie",
        it: "La Notte in Cui le Immagini Presero Vita"
      },
      female: {
        en: "The Night the Pictures Came Alive",
        de: "Die Nacht, in der die Bilder lebendig wurden",
        gsw: "D Nacht, wo d Bilder läbendig worde sind",
        fr: "La Nuit Où les Images Prirent Vie",
        it: "La Notte in Cui le Immagini Presero Vita"
      }
    },
    'first-zoo': {
      male: {
        en: "The Garden of a Thousand Animals",
        de: "Der Garten der tausend Tiere",
        gsw: "De Garte vo de tuusig Tier",
        fr: "Le Jardin aux Mille Animaux",
        it: "Il Giardino dei Mille Animali"
      },
      female: {
        en: "The Garden of a Thousand Animals",
        de: "Der Garten der tausend Tiere",
        gsw: "De Garte vo de tuusig Tier",
        fr: "Le Jardin aux Mille Animaux",
        it: "Il Giardino dei Mille Animali"
      }
    },
    'natural-history-museum': {
      male: {
        en: "The Palace of Wonders",
        de: "Der Palast der Wunder",
        gsw: "De Palascht vo de Wunder",
        fr: "Le Palais des Merveilles",
        it: "Il Palazzo delle Meraviglie"
      },
      female: {
        en: "The Palace of Wonders",
        de: "Der Palast der Wunder",
        gsw: "De Palascht vo de Wunder",
        fr: "Le Palais des Merveilles",
        it: "Il Palazzo delle Meraviglie"
      }
    },

    // ── Archaeological Discoveries ─────────────────────────────────
    'king-tut': {
      male: {
        en: "The Boy King's Hidden Treasure",
        de: "Der verborgene Schatz des jungen Königs",
        gsw: "De verborgeni Schatz vom junge König",
        fr: "Le Trésor Caché du Roi Enfant",
        it: "Il Tesoro Nascosto del Re Bambino"
      },
      female: {
        en: "The Boy King's Hidden Treasure",
        de: "Der verborgene Schatz des jungen Königs",
        gsw: "De verborgeni Schatz vom junge König",
        fr: "Le Trésor Caché du Roi Enfant",
        it: "Il Tesoro Nascosto del Re Bambino"
      }
    },
    'pompeii-discovery': {
      male: {
        en: "The City Frozen in Time",
        de: "Die Stadt, die in der Zeit erstarrte",
        gsw: "D Stadt, wo i de Zyt erstarrt isch",
        fr: "La Cité Figée dans le Temps",
        it: "La Città Cristallizzata nel Tempo"
      },
      female: {
        en: "The City Frozen in Time",
        de: "Die Stadt, die in der Zeit erstarrte",
        gsw: "D Stadt, wo i de Zyt erstarrt isch",
        fr: "La Cité Figée dans le Temps",
        it: "La Città Cristallizzata nel Tempo"
      }
    },
    'terracotta-army': {
      male: {
        en: "The Emperor's Stone Soldiers",
        de: "Die steinernen Soldaten des Kaisers",
        gsw: "D steinige Soldate vom Kaiser",
        fr: "Les Soldats de Pierre de l'Empereur",
        it: "I Soldati di Pietra dell'Imperatore"
      },
      female: {
        en: "The Emperor's Stone Soldiers",
        de: "Die steinernen Soldaten des Kaisers",
        gsw: "D steinige Soldate vom Kaiser",
        fr: "Les Soldats de Pierre de l'Empereur",
        it: "I Soldati di Pietra dell'Imperatore"
      }
    }
  }
};

// Map language codes to the 5 base title languages
function getBaseLanguage(langCode) {
  if (!langCode) return 'en';
  const lc = langCode.toLowerCase();

  // Swiss German dialects → gsw
  if (lc.startsWith('gsw')) return 'gsw';

  // German variants → de
  if (lc.startsWith('de')) return 'de';

  // French variants → fr
  if (lc.startsWith('fr')) return 'fr';

  // Italian variants → it
  if (lc.startsWith('it')) return 'it';

  // English variants and everything else → en
  return 'en';
}

/**
 * Look up a pre-defined trial story title.
 * @param {string} storyTopic - e.g. 'pirate', 'moon-landing'
 * @param {string} storyCategory - 'adventure' or 'historical'
 * @param {string} gender - 'male' or 'female'
 * @param {string} languageCode - any supported language code (e.g. 'de-ch', 'gsw-zh', 'fr', 'en-us')
 * @returns {string|null} The title string, or null if not found
 */
function getTrialTitle(storyTopic, storyCategory, gender, languageCode) {
  const category = TRIAL_TITLES[storyCategory];
  if (!category) return null;

  const topic = category[storyTopic];
  if (!topic) return null;

  const genderTitles = topic[gender || 'male'];
  if (!genderTitles) return null;

  const baseLang = getBaseLanguage(languageCode);
  return genderTitles[baseLang] || genderTitles['en'] || null;
}

module.exports = { TRIAL_TITLES, getTrialTitle };
