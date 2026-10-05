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
        fr: "La grande aventure du petit pirate",
        it: "La grande avventura del piccolo pirata"
      },
      female: {
        en: "The Little Pirate's Great Adventure",
        de: "Das grosse Abenteuer der kleinen Piratin",
        gsw: "S grosse Abentüür vo de chline Piratin",
        fr: "La grande aventure de la petite pirate",
        it: "La grande avventura della piccola pirata"
      }
    },
    knight: {
      male: {
        en: "The Brave Knight and the Secret Kingdom",
        de: "Der tapfere Ritter und das geheime Königreich",
        gsw: "De tapfer Ritter und s gheime Chönigriich",
        fr: "Le brave chevalier et le royaume secret",
        it: "Il coraggioso cavaliere e il regno segreto"
      },
      female: {
        en: "The Brave Knight and the Secret Kingdom",
        de: "Die tapfere Ritterin und das geheime Königreich",
        gsw: "Die tapferi Ritterin und s gheime Chönigriich",
        fr: "La brave chevalière et le royaume secret",
        it: "La coraggiosa cavaliera e il regno segreto"
      }
    },
    cowboy: {
      male: {
        en: "Ride into the Sunset — A Wild West Tale",
        de: "Ritt in den Sonnenuntergang — Ein Wilder-Westen-Abenteuer",
        gsw: "Ritt in de Sunneundergang — Es Wilde-Weste-Abentüür",
        fr: "Chevauchée vers le couchant — Un conte du Far West",
        it: "Cavalcata nel tramonto — un'avventura nel Selvaggio West"
      },
      female: {
        en: "Ride into the Sunset — A Wild West Tale",
        de: "Ritt in den Sonnenuntergang — Ein Wilder-Westen-Abenteuer",
        gsw: "Ritt in de Sunneundergang — Es Wilde-Weste-Abentüür",
        fr: "Chevauchée vers le couchant — Un conte du Far West",
        it: "Cavalcata nel tramonto — un'avventura nel Selvaggio West"
      }
    },
    ninja: {
      male: {
        en: "Shadow of the Little Ninja",
        de: "Der Schatten des kleinen Ninja",
        gsw: "De Schatte vom chline Ninja",
        fr: "L'ombre du petit ninja",
        it: "L'ombra del piccolo ninja"
      },
      female: {
        en: "Shadow of the Little Ninja",
        de: "Der Schatten der kleinen Ninja",
        gsw: "De Schatte vo de chline Ninja",
        fr: "L'ombre de la petite ninja",
        it: "L'ombra della piccola ninja"
      }
    },
    viking: {
      male: {
        en: "Voyage of the Fearless Viking",
        de: "Die Reise des furchtlosen Wikingers",
        gsw: "D Reis vom furchtlose Wikinger",
        fr: "Le voyage du viking intrépide",
        it: "Il viaggio del vichingo intrepido"
      },
      female: {
        en: "Voyage of the Fearless Viking",
        de: "Die Reise der furchtlosen Wikingerin",
        gsw: "D Reis vo de furchtlose Wikingerin",
        fr: "Le voyage de la viking intrépide",
        it: "Il viaggio della vichinga intrepida"
      }
    },
    roman: {
      male: {
        en: "A Day in Ancient Rome",
        de: "Ein Tag im alten Rom",
        gsw: "En Tag im alte Rom",
        fr: "Une journée dans la Rome antique",
        it: "Un giorno nell'antica Roma"
      },
      female: {
        en: "A Day in Ancient Rome",
        de: "Ein Tag im alten Rom",
        gsw: "En Tag im alte Rom",
        fr: "Une journée dans la Rome antique",
        it: "Un giorno nell'antica Roma"
      }
    },
    egyptian: {
      male: {
        en: "The Secret of the Golden Pyramid",
        de: "Das Geheimnis der goldenen Pyramide",
        gsw: "S Gheimnis vo de goldige Pyramide",
        fr: "Le secret de la pyramide dorée",
        it: "Il segreto della piramide dorata"
      },
      female: {
        en: "The Secret of the Golden Pyramid",
        de: "Das Geheimnis der goldenen Pyramide",
        gsw: "S Gheimnis vo de goldige Pyramide",
        fr: "Le secret de la pyramide dorée",
        it: "Il segreto della piramide dorata"
      }
    },
    greek: {
      male: {
        en: "The Little Hero of Mount Olympus",
        de: "Der kleine Held vom Olymp",
        gsw: "De chli Held vom Olymp",
        fr: "Le petit héros de l'Olympe",
        it: "Il piccolo eroe dell'Olimpo"
      },
      female: {
        en: "The Little Heroine of Mount Olympus",
        de: "Die kleine Heldin vom Olymp",
        gsw: "Die chli Heldin vom Olymp",
        fr: "La petite héroïne de l'Olympe",
        it: "La piccola eroina dell'Olimpo"
      }
    },
    caveman: {
      male: {
        en: "The Stone Age Explorer",
        de: "Der Entdecker aus der Steinzeit",
        gsw: "De Entdecker us de Steizit",
        fr: "L'explorateur de l'âge de pierre",
        it: "L'esploratore dell'età della pietra"
      },
      female: {
        en: "The Stone Age Explorer",
        de: "Die Entdeckerin aus der Steinzeit",
        gsw: "D Entdeckerin us de Steizit",
        fr: "L'exploratrice de l'âge de pierre",
        it: "L'esploratrice dell'età della pietra"
      }
    },
    samurai: {
      male: {
        en: "The Way of the Little Samurai",
        de: "Der Weg des kleinen Samurai",
        gsw: "De Wäg vom chline Samurai",
        fr: "La voie du petit samouraï",
        it: "La via del piccolo samurai"
      },
      female: {
        en: "The Way of the Little Samurai",
        de: "Der Weg der kleinen Samurai",
        gsw: "De Wäg vo de chline Samurai",
        fr: "La voie de la petite samouraï",
        it: "La via della piccola samurai"
      }
    },
    wizard: {
      male: {
        en: "The Little Wizard and the Enchanted Spell",
        de: "Der kleine Zauberer und der verzauberte Spruch",
        gsw: "De chli Zauberer und de verzauberti Spruch",
        fr: "Le petit sorcier et le sortilège enchanté",
        it: "Il piccolo mago e l'incantesimo fatato"
      },
      female: {
        en: "The Little Witch and the Enchanted Spell",
        de: "Die kleine Zauberin und der verzauberte Spruch",
        gsw: "Die chli Zauberin und de verzauberti Spruch",
        fr: "La petite sorcière et le sortilège enchanté",
        it: "La piccola maga e l'incantesimo fatato"
      }
    },
    dragon: {
      male: {
        en: "The Boy Who Befriended a Dragon",
        de: "Der Junge, der einen Drachen zähmte",
        gsw: "De Bueb, wo en Drache zähmt het",
        fr: "Le garçon qui apprivoisa un dragon",
        it: "Il ragazzo che addomesticò un drago"
      },
      female: {
        en: "The Girl Who Befriended a Dragon",
        de: "Das Mädchen, das einen Drachen zähmte",
        gsw: "S Meitli, wo en Drache zähmt het",
        fr: "La fille qui apprivoisa un dragon",
        it: "La ragazza che addomesticò un drago"
      }
    },
    superhero: {
      male: {
        en: "The World's Smallest Superhero",
        de: "Der kleinste Superheld der Welt",
        gsw: "De chlinst Superheld vo de Wält",
        fr: "Le plus petit super-héros du monde",
        it: "Il più piccolo supereroe del mondo"
      },
      female: {
        en: "The World's Smallest Superheroine",
        de: "Die kleinste Superheldin der Welt",
        gsw: "Die chlinst Superheldin vo de Wält",
        fr: "La plus petite super-héroïne du monde",
        it: "La più piccola supereroina del mondo"
      }
    },
    detective: {
      male: {
        en: "The Case of the Missing Treasure",
        de: "Der Fall des verschwundenen Schatzes",
        gsw: "De Fall vom verschwundne Schatz",
        fr: "L'affaire du trésor disparu",
        it: "Il caso del tesoro scomparso"
      },
      female: {
        en: "The Case of the Missing Treasure",
        de: "Der Fall des verschwundenen Schatzes",
        gsw: "De Fall vom verschwundne Schatz",
        fr: "L'affaire du trésor disparu",
        it: "Il caso del tesoro scomparso"
      }
    },
    unicorn: {
      male: {
        en: "The Rainbow Unicorn's Magical Journey",
        de: "Die magische Reise des Regenbogen-Einhorns",
        gsw: "Die magischi Reis vom Rägeboge-Eihorn",
        fr: "Le voyage magique de la licorne arc-en-ciel",
        it: "Il viaggio magico dell'unicorno arcobaleno"
      },
      female: {
        en: "The Rainbow Unicorn's Magical Journey",
        de: "Die magische Reise des Regenbogen-Einhorns",
        gsw: "Die magischi Reis vom Rägeboge-Eihorn",
        fr: "Le voyage magique de la licorne arc-en-ciel",
        it: "Il viaggio magico dell'unicorno arcobaleno"
      }
    },
    mermaid: {
      male: {
        en: "Secrets Beneath the Waves",
        de: "Geheimnisse unter den Wellen",
        gsw: "Gheimnisse under de Wälle",
        fr: "Secrets sous les vagues",
        it: "Segreti sotto le onde"
      },
      female: {
        en: "Secrets Beneath the Waves",
        de: "Geheimnisse unter den Wellen",
        gsw: "Gheimnisse under de Wälle",
        fr: "Secrets sous les vagues",
        it: "Segreti sotto le onde"
      }
    },
    dinosaur: {
      male: {
        en: "The Land Before Time Forgot",
        de: "Das Land, das die Zeit vergass",
        gsw: "S Land, wo d Zit vergässe het",
        fr: "Le pays que le temps a oublié",
        it: "La terra che il tempo ha dimenticato"
      },
      female: {
        en: "The Land Before Time Forgot",
        de: "Das Land, das die Zeit vergass",
        gsw: "S Land, wo d Zit vergässe het",
        fr: "Le pays que le temps a oublié",
        it: "La terra che il tempo ha dimenticato"
      }
    },
    space: {
      male: {
        en: "Mission to the Stars",
        de: "Mission zu den Sternen",
        gsw: "Mission zu de Stärne",
        fr: "Mission vers les étoiles",
        it: "Missione verso le stelle"
      },
      female: {
        en: "Mission to the Stars",
        de: "Mission zu den Sternen",
        gsw: "Mission zu de Stärne",
        fr: "Mission vers les étoiles",
        it: "Missione verso le stelle"
      }
    },
    ocean: {
      male: {
        en: "The Deep Blue Sea Adventure",
        de: "Abenteuer in der Tiefsee",
        gsw: "Abentüür in de Tüüfsee",
        fr: "L'aventure des profondeurs marines",
        it: "L'avventura negli abissi marini"
      },
      female: {
        en: "The Deep Blue Sea Adventure",
        de: "Abenteuer in der Tiefsee",
        gsw: "Abentüür in de Tüüfsee",
        fr: "L'aventure des profondeurs marines",
        it: "L'avventura negli abissi marini"
      }
    },
    jungle: {
      male: {
        en: "Through the Wild Jungle",
        de: "Durch den wilden Dschungel",
        gsw: "Dur de wild Dschungel",
        fr: "À travers la jungle sauvage",
        it: "Attraverso la giungla selvaggia"
      },
      female: {
        en: "Through the Wild Jungle",
        de: "Durch den wilden Dschungel",
        gsw: "Dur de wild Dschungel",
        fr: "À travers la jungle sauvage",
        it: "Attraverso la giungla selvaggia"
      }
    },
    farm: {
      male: {
        en: "A Wonderful Day on the Farm",
        de: "Ein wunderbarer Tag auf dem Bauernhof",
        gsw: "En wunderbari Tag uf em Burehof",
        fr: "Une journée merveilleuse à la ferme",
        it: "Una giornata meravigliosa alla fattoria"
      },
      female: {
        en: "A Wonderful Day on the Farm",
        de: "Ein wunderbarer Tag auf dem Bauernhof",
        gsw: "En wunderbari Tag uf em Burehof",
        fr: "Une journée merveilleuse à la ferme",
        it: "Una giornata meravigliosa alla fattoria"
      }
    },
    forest: {
      male: {
        en: "The Enchanted Forest Quest",
        de: "Die Suche im verzauberten Wald",
        gsw: "D Suechi im verzauberte Wald",
        fr: "La quête de la forêt enchantée",
        it: "La ricerca nella foresta incantata"
      },
      female: {
        en: "The Enchanted Forest Quest",
        de: "Die Suche im verzauberten Wald",
        gsw: "D Suechi im verzauberte Wald",
        fr: "La quête de la forêt enchantée",
        it: "La ricerca nella foresta incantata"
      }
    },
    fireman: {
      male: {
        en: "The Brave Little Firefighter",
        de: "Der mutige kleine Feuerwehrmann",
        gsw: "De muetig chli Füürwehrma",
        fr: "Le petit pompier courageux",
        it: "Il piccolo pompiere coraggioso"
      },
      female: {
        en: "The Brave Little Firefighter",
        de: "Die mutige kleine Feuerwehrfrau",
        gsw: "Die muetig chli Füürwehrfrau",
        fr: "La petite pompière courageuse",
        it: "La piccola pompiera coraggiosa"
      }
    },
    doctor: {
      male: {
        en: "The Little Doctor's Big Day",
        de: "Der grosse Tag des kleinen Doktors",
        gsw: "De gross Tag vom chline Dokter",
        fr: "La grande journée du petit docteur",
        it: "Il grande giorno del piccolo dottore"
      },
      female: {
        en: "The Little Doctor's Big Day",
        de: "Der grosse Tag der kleinen Doktorin",
        gsw: "De gross Tag vo de chline Doktorin",
        fr: "La grande journée de la petite docteure",
        it: "Il grande giorno della piccola dottoressa"
      }
    },
    police: {
      male: {
        en: "On Patrol — A Police Adventure",
        de: "Auf Streife — Ein Polizei-Abenteuer",
        gsw: "Uf Streifi — Es Polizei-Abentüür",
        fr: "En patrouille — Une aventure de police",
        it: "In pattuglia — un'avventura della polizia"
      },
      female: {
        en: "On Patrol — A Police Adventure",
        de: "Auf Streife — Ein Polizei-Abenteuer",
        gsw: "Uf Streifi — Es Polizei-Abentüür",
        fr: "En patrouille — Une aventure de police",
        it: "In pattuglia — un'avventura della polizia"
      }
    },
    christmas: {
      male: {
        en: "The Most Magical Christmas Eve",
        de: "Der zauberhafteste Heiligabend",
        gsw: "De zauberhaftist Heiligabe",
        fr: "Le réveillon de Noël le plus magique",
        it: "La vigilia di Natale più magica"
      },
      female: {
        en: "The Most Magical Christmas Eve",
        de: "Der zauberhafteste Heiligabend",
        gsw: "De zauberhaftist Heiligabe",
        fr: "Le réveillon de Noël le plus magique",
        it: "La vigilia di Natale più magica"
      }
    },
    newyear: {
      male: {
        en: "The Midnight New Year's Surprise",
        de: "Die Mitternachts-Überraschung an Silvester",
        gsw: "D Mitternachts-Überraschig a Silveschter",
        fr: "La surprise de minuit du nouvel an",
        it: "La sorpresa di mezzanotte di Capodanno"
      },
      female: {
        en: "The Midnight New Year's Surprise",
        de: "Die Mitternachts-Überraschung an Silvester",
        gsw: "D Mitternachts-Überraschig a Silveschter",
        fr: "La surprise de minuit du nouvel an",
        it: "La sorpresa di mezzanotte di Capodanno"
      }
    },
    easter: {
      male: {
        en: "The Great Easter Egg Hunt",
        de: "Die grosse Ostereier-Suche",
        gsw: "Die gross Oschtereier-Suechi",
        fr: "La grande chasse aux œufs de Pâques",
        it: "La grande caccia alle uova di Pasqua"
      },
      female: {
        en: "The Great Easter Egg Hunt",
        de: "Die grosse Ostereier-Suche",
        gsw: "Die gross Oschtereier-Suechi",
        fr: "La grande chasse aux œufs de Pâques",
        it: "La grande caccia alle uova di Pasqua"
      }
    },
    halloween: {
      male: {
        en: "The Spooky Halloween Night",
        de: "Die gruselige Halloween-Nacht",
        gsw: "Die grusigi Halloween-Nacht",
        fr: "La nuit d'Halloween frissonnante",
        it: "La notte di Halloween da brivido"
      },
      female: {
        en: "The Spooky Halloween Night",
        de: "Die gruselige Halloween-Nacht",
        gsw: "Die grusigi Halloween-Nacht",
        fr: "La nuit d'Halloween frissonnante",
        it: "La notte di Halloween da brivido"
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
        fr: "Le secret des montagnes suisses",
        it: "Il segreto delle montagne svizzere"
      },
      female: {
        en: "The Secret of the Swiss Mountains",
        de: "Das Geheimnis der Schweizer Berge",
        gsw: "S Gheimnis vo de Schwizer Bärge",
        fr: "Le secret des montagnes suisses",
        it: "Il segreto delle montagne svizzere"
      }
    },
    'wilhelm-tell': {
      male: {
        en: "The Boy Who Never Missed",
        de: "Der Junge, der nie daneben schoss",
        gsw: "De Bueb, wo nie dänäbe gschosse het",
        fr: "Le garçon qui ne manquait jamais",
        it: "Il ragazzo che non mancava mai"
      },
      female: {
        en: "The Girl Who Never Missed",
        de: "Das Mädchen, das nie daneben schoss",
        gsw: "S Meitli, wo nie dänäbe gschosse het",
        fr: "La fille qui ne manquait jamais",
        it: "La ragazza che non mancava mai"
      }
    },
    'battle-morgarten': {
      male: {
        en: "Thunder on the Mountain Pass",
        de: "Donner am Bergpass",
        gsw: "Donner am Bärgpass",
        fr: "Tonnerre sur le col de montagne",
        it: "Tuono sul passo di montagna"
      },
      female: {
        en: "Thunder on the Mountain Pass",
        de: "Donner am Bergpass",
        gsw: "Donner am Bärgpass",
        fr: "Tonnerre sur le col de montagne",
        it: "Tuono sul passo di montagna"
      }
    },
    'battle-sempach': {
      male: {
        en: "The Brave Hearts of Sempach",
        de: "Die tapferen Herzen von Sempach",
        gsw: "Die tapfere Härze vo Sempach",
        fr: "Les cœurs vaillants de Sempach",
        it: "I cuori coraggiosi di Sempach"
      },
      female: {
        en: "The Brave Hearts of Sempach",
        de: "Die tapferen Herzen von Sempach",
        gsw: "Die tapfere Härze vo Sempach",
        fr: "Les cœurs vaillants de Sempach",
        it: "I cuori coraggiosi di Sempach"
      }
    },
    'swiss-reformation': {
      male: {
        en: "The Boy with the Forbidden Book",
        de: "Der Junge mit dem verbotenen Buch",
        gsw: "De Bueb mit em verbotene Buech",
        fr: "Le garçon au livre interdit",
        it: "Il ragazzo con il libro proibito"
      },
      female: {
        en: "The Girl with the Forbidden Book",
        de: "Das Mädchen mit dem verbotenen Buch",
        gsw: "S Meitli mit em verbotene Buech",
        fr: "La fille au livre interdit",
        it: "La ragazza con il libro proibito"
      }
    },
    'red-cross-founding': {
      male: {
        en: "The Little Helper of Solferino",
        de: "Der kleine Helfer von Solferino",
        gsw: "De chli Hälfer vo Solferino",
        fr: "Le petit secouriste de Solférino",
        it: "Il piccolo soccorritore di Solferino"
      },
      female: {
        en: "The Little Helper of Solferino",
        de: "Die kleine Helferin von Solferino",
        gsw: "S chli Hälferi vo Solferino",
        fr: "La petite secouriste de Solférino",
        it: "La piccola soccorritrice di Solferino"
      }
    },
    'general-dufour': {
      male: {
        en: "The Mapmaker's Great Adventure",
        de: "Das grosse Abenteuer des Kartografen",
        gsw: "S grosse Abentüür vom Chartograf",
        fr: "La grande aventure du cartographe",
        it: "La grande avventura del cartografo"
      },
      female: {
        en: "The Mapmaker's Great Adventure",
        de: "Das grosse Abenteuer der Kartografin",
        gsw: "S grosse Abentüür vo de Chartografin",
        fr: "La grande aventure de la cartographe",
        it: "La grande avventura della cartografa"
      }
    },
    'sonderbund-war': {
      male: {
        en: "The Boy Who United a Nation",
        de: "Der Junge, der ein Land vereinte",
        gsw: "De Bueb, wo es Land vereint het",
        fr: "Le garçon qui unifia un pays",
        it: "Il ragazzo che unì una nazione"
      },
      female: {
        en: "The Girl Who United a Nation",
        de: "Das Mädchen, das ein Land vereinte",
        gsw: "S Meitli, wo es Land vereint het",
        fr: "La fille qui unifia un pays",
        it: "La ragazza che unì una nazione"
      }
    },
    'swiss-constitution': {
      male: {
        en: "The Promise of the Parchment",
        de: "Das Versprechen auf dem Pergament",
        gsw: "S Verspräche uf em Pergamänt",
        fr: "La promesse du parchemin",
        it: "La promessa della pergamena"
      },
      female: {
        en: "The Promise of the Parchment",
        de: "Das Versprechen auf dem Pergament",
        gsw: "S Verspräche uf em Pergamänt",
        fr: "La promesse du parchemin",
        it: "La promessa della pergamena"
      }
    },
    'gotthard-tunnel': {
      male: {
        en: "Digging Through the Mountain",
        de: "Der Tunnel durch den Berg",
        gsw: "De Tunnel dure Berg",
        fr: "Le tunnel à travers la montagne",
        it: "Il tunnel attraverso la montagna"
      },
      female: {
        en: "Digging Through the Mountain",
        de: "Der Tunnel durch den Berg",
        gsw: "De Tunnel dure Berg",
        fr: "Le tunnel à travers la montagne",
        it: "Il tunnel attraverso la montagna"
      }
    },
    'swiss-ww1-neutrality': {
      male: {
        en: "The Lighthouse Between the Storms",
        de: "Der Leuchtturm zwischen den Stürmen",
        gsw: "De Lüüchtturm zwüsche de Stürm",
        fr: "Le phare entre les tempêtes",
        it: "Il faro tra le tempeste"
      },
      female: {
        en: "The Lighthouse Between the Storms",
        de: "Der Leuchtturm zwischen den Stürmen",
        gsw: "De Lüüchtturm zwüsche de Stürm",
        fr: "Le phare entre les tempêtes",
        it: "Il faro tra le tempeste"
      }
    },
    'general-guisan': {
      male: {
        en: "The Guardian of the Alps",
        de: "Der Wächter der Alpen",
        gsw: "De Wächter vo de Alpe",
        fr: "Le gardien des Alpes",
        it: "Il guardiano delle Alpi"
      },
      female: {
        en: "The Guardian of the Alps",
        de: "Die Wächterin der Alpen",
        gsw: "D Wächterin vo de Alpe",
        fr: "La gardienne des Alpes",
        it: "La guardiana delle Alpi"
      }
    },
    'swiss-ww2-neutrality': {
      male: {
        en: "The Brave Little Country",
        de: "Das mutige kleine Land",
        gsw: "S muetige chline Land",
        fr: "Le petit pays courageux",
        it: "Il piccolo paese coraggioso"
      },
      female: {
        en: "The Brave Little Country",
        de: "Das mutige kleine Land",
        gsw: "S muetige chline Land",
        fr: "Le petit pays courageux",
        it: "Il piccolo paese coraggioso"
      }
    },
    'swiss-womens-vote': {
      male: {
        en: "The Day Every Voice Counted",
        de: "Der Tag, an dem jede Stimme zählte",
        gsw: "De Tag, wo jedi Stimm zellt het",
        fr: "Le jour où chaque voix a compté",
        it: "Il giorno in cui ogni voce contò"
      },
      female: {
        en: "The Day Every Voice Counted",
        de: "Der Tag, an dem jede Stimme zählte",
        gsw: "De Tag, wo jedi Stimm zellt het",
        fr: "Le jour où chaque voix a compté",
        it: "Il giorno in cui ogni voce contò"
      }
    },

    // ── Exploration & Discovery ────────────────────────────────────
    'moon-landing': {
      male: {
        en: "One Small Step for a Big Dream",
        de: "Ein kleiner Schritt für einen grossen Traum",
        gsw: "Es chlises Schrittli für en grosse Traum",
        fr: "Un petit pas pour un grand rêve",
        it: "Un piccolo passo per un grande sogno"
      },
      female: {
        en: "One Small Step for a Big Dream",
        de: "Ein kleiner Schritt für einen grossen Traum",
        gsw: "Es chlises Schrittli für en grosse Traum",
        fr: "Un petit pas pour un grand rêve",
        it: "Un piccolo passo per un grande sogno"
      }
    },
    'columbus-voyage': {
      male: {
        en: "Sailing Beyond the Edge of the World",
        de: "Segeln über den Rand der Welt",
        gsw: "Segle über de Rand vo de Wält",
        fr: "Naviguer au-delà du bout du monde",
        it: "Navigare oltre il confine del mondo"
      },
      female: {
        en: "Sailing Beyond the Edge of the World",
        de: "Segeln über den Rand der Welt",
        gsw: "Segle über de Rand vo de Wält",
        fr: "Naviguer au-delà du bout du monde",
        it: "Navigare oltre il confine del mondo"
      }
    },
    'wright-brothers': {
      male: {
        en: "The Boy Who Learned to Fly",
        de: "Der Junge, der fliegen lernte",
        gsw: "De Bueb, wo flüge glehrt het",
        fr: "Le garçon qui apprit à voler",
        it: "Il ragazzo che imparò a volare"
      },
      female: {
        en: "The Girl Who Learned to Fly",
        de: "Das Mädchen, das fliegen lernte",
        gsw: "S Meitli, wo flüge glehrt het",
        fr: "La fille qui apprit à voler",
        it: "La ragazza che imparò a volare"
      }
    },
    'lindbergh-flight': {
      male: {
        en: "Alone Above the Ocean",
        de: "Allein über dem Ozean",
        gsw: "Elei über em Ozean",
        fr: "Seul au-dessus de l'océan",
        it: "Solo sopra l'oceano"
      },
      female: {
        en: "Alone Above the Ocean",
        de: "Allein über dem Ozean",
        gsw: "Elei über em Ozean",
        fr: "Seule au-dessus de l'océan",
        it: "Sola sopra l'oceano"
      }
    },
    'everest-summit': {
      male: {
        en: "The Top of the World",
        de: "Auf dem Dach der Welt",
        gsw: "Uf em Dach vo de Wält",
        fr: "Le sommet du monde",
        it: "La cima del mondo"
      },
      female: {
        en: "The Top of the World",
        de: "Auf dem Dach der Welt",
        gsw: "Uf em Dach vo de Wält",
        fr: "Le sommet du monde",
        it: "La cima del mondo"
      }
    },
    'south-pole': {
      male: {
        en: "Race to the Frozen End of the Earth",
        de: "Wettlauf zum gefrorenen Ende der Welt",
        gsw: "Wettlouf zum gfrorene Ändi vo de Wält",
        fr: "La course vers le bout gelé du monde",
        it: "La corsa verso la fine ghiacciata del mondo"
      },
      female: {
        en: "Race to the Frozen End of the Earth",
        de: "Wettlauf zum gefrorenen Ende der Welt",
        gsw: "Wettlouf zum gfrorene Ändi vo de Wält",
        fr: "La course vers le bout gelé du monde",
        it: "La corsa verso la fine ghiacciata del mondo"
      }
    },
    'magellan-circumnavigation': {
      male: {
        en: "All the Way Around the World",
        de: "Einmal um die ganze Welt",
        gsw: "Einisch um die ganzi Wält",
        fr: "Le tour du monde entier",
        it: "Il giro di tutto il mondo"
      },
      female: {
        en: "All the Way Around the World",
        de: "Einmal um die ganze Welt",
        gsw: "Einisch um die ganzi Wält",
        fr: "Le tour du monde entier",
        it: "Il giro di tutto il mondo"
      }
    },
    'mariana-trench': {
      male: {
        en: "Journey to the Deepest Deep",
        de: "Reise in die tiefste Tiefe",
        gsw: "Reis i die tüüfschti Tüüfi",
        fr: "Voyage au plus profond des abysses",
        it: "Viaggio nel più profondo degli abissi"
      },
      female: {
        en: "Journey to the Deepest Deep",
        de: "Reise in die tiefste Tiefe",
        gsw: "Reis i die tüüfschti Tüüfi",
        fr: "Voyage au plus profond des abysses",
        it: "Viaggio nel più profondo degli abissi"
      }
    },

    // ── Science & Medicine ─────────────────────────────────────────
    'electricity-discovery': {
      male: {
        en: "The Boy Who Caught Lightning",
        de: "Der Junge, der den Blitz fing",
        gsw: "De Bueb, wo de Blitz gfange het",
        fr: "Le garçon qui attrapa la foudre",
        it: "Il ragazzo che catturò il fulmine"
      },
      female: {
        en: "The Girl Who Caught Lightning",
        de: "Das Mädchen, das den Blitz fing",
        gsw: "S Meitli, wo de Blitz gfange het",
        fr: "La fille qui attrapa la foudre",
        it: "La ragazza che catturò il fulmine"
      }
    },
    'penicillin': {
      male: {
        en: "The Magical Mould",
        de: "Der wunderbare Schimmelpilz",
        gsw: "De wunderbar Schimmelpilz",
        fr: "La moisissure magique",
        it: "La muffa magica"
      },
      female: {
        en: "The Magical Mould",
        de: "Der wunderbare Schimmelpilz",
        gsw: "De wunderbar Schimmelpilz",
        fr: "La moisissure magique",
        it: "La muffa magica"
      }
    },
    'vaccine-discovery': {
      male: {
        en: "The Doctor and the Milkmaid's Secret",
        de: "Der Arzt und das Geheimnis der Magd",
        gsw: "De Dokter und s Gheimnis vo de Magd",
        fr: "Le médecin et le secret de la laitière",
        it: "Il dottore e il segreto della lattaia"
      },
      female: {
        en: "The Doctor and the Milkmaid's Secret",
        de: "Die Ärztin und das Geheimnis der Magd",
        gsw: "D Dokterin und s Gheimnis vo de Magd",
        fr: "La médecin et le secret de la laitière",
        it: "La dottoressa e il segreto della lattaia"
      }
    },
    'dna-discovery': {
      male: {
        en: "The Invisible Code of Life",
        de: "Der unsichtbare Code des Lebens",
        gsw: "De unsichtbar Code vom Läbe",
        fr: "Le code invisible de la vie",
        it: "Il codice invisibile della vita"
      },
      female: {
        en: "The Invisible Code of Life",
        de: "Der unsichtbare Code des Lebens",
        gsw: "De unsichtbar Code vom Läbe",
        fr: "Le code invisible de la vie",
        it: "Il codice invisibile della vita"
      }
    },
    'dinosaur-discovery': {
      male: {
        en: "The Boy Who Found the Dragon Bones",
        de: "Der Junge, der die Drachenknochen fand",
        gsw: "De Bueb, wo d Drachechnoche gfunde het",
        fr: "Le garçon qui trouva les os du dragon",
        it: "Il ragazzo che trovò le ossa del drago"
      },
      female: {
        en: "The Girl Who Found the Dragon Bones",
        de: "Das Mädchen, das die Drachenknochen fand",
        gsw: "S Meitli, wo d Drachechnoche gfunde het",
        fr: "La fille qui trouva les os du dragon",
        it: "La ragazza che trovò le ossa del drago"
      }
    },
    'einstein-relativity': {
      male: {
        en: "The Boy Who Raced a Beam of Light",
        de: "Der Junge, der mit dem Licht um die Wette lief",
        gsw: "De Bueb, wo mit em Liecht um d Wett grannt isch",
        fr: "Le garçon qui fit la course avec la lumière",
        it: "Il ragazzo che gareggiò con un raggio di luce"
      },
      female: {
        en: "The Girl Who Raced a Beam of Light",
        de: "Das Mädchen, das mit dem Licht um die Wette lief",
        gsw: "S Meitli, wo mit em Liecht um d Wett grannt isch",
        fr: "La fille qui fit la course avec la lumière",
        it: "La ragazza che gareggiò con un raggio di luce"
      }
    },
    'galapagos-darwin': {
      male: {
        en: "The Island of Extraordinary Animals",
        de: "Die Insel der wundersamen Tiere",
        gsw: "D Insle vo de wundersame Tier",
        fr: "L'île des animaux extraordinaires",
        it: "L'isola degli animali straordinari"
      },
      female: {
        en: "The Island of Extraordinary Animals",
        de: "Die Insel der wundersamen Tiere",
        gsw: "D Insle vo de wundersame Tier",
        fr: "L'île des animaux extraordinaires",
        it: "L'isola degli animali straordinari"
      }
    },
    'first-heart-transplant': {
      male: {
        en: "The Doctor with the Bravest Hands",
        de: "Der Arzt mit den mutigsten Händen",
        gsw: "De Dokter mit de muetigste Händ",
        fr: "Le médecin aux mains les plus courageuses",
        it: "Il dottore con le mani più coraggiose"
      },
      female: {
        en: "The Doctor with the Bravest Hands",
        de: "Die Ärztin mit den mutigsten Händen",
        gsw: "D Dokterin mit de muetigste Händ",
        fr: "La médecin aux mains les plus courageuses",
        it: "La dottoressa con le mani più coraggiose"
      }
    },
    'human-genome': {
      male: {
        en: "The Treasure Map Inside You",
        de: "Die Schatzkarte in dir",
        gsw: "D Schatzchart i dir",
        fr: "La carte au trésor cachée en vous",
        it: "La mappa del tesoro dentro di te"
      },
      female: {
        en: "The Treasure Map Inside You",
        de: "Die Schatzkarte in dir",
        gsw: "D Schatzchart i dir",
        fr: "La carte au trésor cachée en vous",
        it: "La mappa del tesoro dentro di te"
      }
    },
    'hubble-launch': {
      male: {
        en: "The Eye That Sees Forever",
        de: "Das Auge, das bis in die Unendlichkeit sieht",
        gsw: "S Aug, wo bis i d Unändlichkeit gseht",
        fr: "L'œil qui voit l'infini",
        it: "L'occhio che vede l'infinito"
      },
      female: {
        en: "The Eye That Sees Forever",
        de: "Das Auge, das bis in die Unendlichkeit sieht",
        gsw: "S Aug, wo bis i d Unändlichkeit gseht",
        fr: "L'œil qui voit l'infini",
        it: "L'occhio che vede l'infinito"
      }
    },

    // ── Inventions ─────────────────────────────────────────────────
    'telephone-invention': {
      male: {
        en: "The Wire That Could Whisper",
        de: "Der Draht, der flüstern konnte",
        gsw: "De Draht, wo het chöne flüstere",
        fr: "Le fil qui savait chuchoter",
        it: "Il filo che sapeva sussurrare"
      },
      female: {
        en: "The Wire That Could Whisper",
        de: "Der Draht, der flüstern konnte",
        gsw: "De Draht, wo het chöne flüstere",
        fr: "Le fil qui savait chuchoter",
        it: "Il filo che sapeva sussurrare"
      }
    },
    'light-bulb': {
      male: {
        en: "The Boy Who Lit Up the Night",
        de: "Der Junge, der die Nacht erleuchtete",
        gsw: "De Bueb, wo d Nacht erlüchtet het",
        fr: "Le garçon qui illumina la nuit",
        it: "Il ragazzo che illuminò la notte"
      },
      female: {
        en: "The Girl Who Lit Up the Night",
        de: "Das Mädchen, das die Nacht erleuchtete",
        gsw: "S Meitli, wo d Nacht erlüchtet het",
        fr: "La fille qui illumina la nuit",
        it: "La ragazza che illuminò la notte"
      }
    },
    'printing-press': {
      male: {
        en: "The Machine That Made Words Fly",
        de: "Die Maschine, die Wörter fliegen liess",
        gsw: "D Maschine, wo d Wörter het la flüge",
        fr: "La machine qui faisait voler les mots",
        it: "La macchina che faceva volare le parole"
      },
      female: {
        en: "The Machine That Made Words Fly",
        de: "Die Maschine, die Wörter fliegen liess",
        gsw: "D Maschine, wo d Wörter het la flüge",
        fr: "La machine qui faisait voler les mots",
        it: "La macchina che faceva volare le parole"
      }
    },
    'internet-creation': {
      male: {
        en: "The Invisible Web That Connected the World",
        de: "Das unsichtbare Netz, das die Welt verband",
        gsw: "S unsichtbare Netz, wo d Wält verbunde het",
        fr: "La toile invisible qui relia le monde",
        it: "La rete invisibile che collegò il mondo"
      },
      female: {
        en: "The Invisible Web That Connected the World",
        de: "Das unsichtbare Netz, das die Welt verband",
        gsw: "S unsichtbare Netz, wo d Wält verbunde het",
        fr: "La toile invisible qui relia le monde",
        it: "La rete invisibile che collegò il mondo"
      }
    },

    // ── Human Rights & Freedom ─────────────────────────────────────
    'emancipation': {
      male: {
        en: "The Day the Chains Broke",
        de: "Der Tag, an dem die Ketten brachen",
        gsw: "De Tag, wo d Chette broche sind",
        fr: "Le jour où les chaînes se brisèrent",
        it: "Il giorno in cui le catene si spezzarono"
      },
      female: {
        en: "The Day the Chains Broke",
        de: "Der Tag, an dem die Ketten brachen",
        gsw: "De Tag, wo d Chette broche sind",
        fr: "Le jour où les chaînes se brisèrent",
        it: "Il giorno in cui le catene si spezzarono"
      }
    },
    'womens-suffrage': {
      male: {
        en: "The March for a Million Voices",
        de: "Der Marsch für eine Million Stimmen",
        gsw: "De Marsch für e Million Stimme",
        fr: "La marche pour un million de voix",
        it: "La marcia per un milione di voci"
      },
      female: {
        en: "The March for a Million Voices",
        de: "Der Marsch für eine Million Stimmen",
        gsw: "De Marsch für e Million Stimme",
        fr: "La marche pour un million de voix",
        it: "La marcia per un milione di voci"
      }
    },
    'rosa-parks': {
      male: {
        en: "The Seat That Changed the World",
        de: "Der Sitzplatz, der die Welt veränderte",
        gsw: "De Sitzplatz, wo d Wält veränderet het",
        fr: "Le siège qui changea le monde",
        it: "Il posto che cambiò il mondo"
      },
      female: {
        en: "The Seat That Changed the World",
        de: "Der Sitzplatz, der die Welt veränderte",
        gsw: "De Sitzplatz, wo d Wält veränderet het",
        fr: "Le siège qui changea le monde",
        it: "Il posto che cambiò il mondo"
      }
    },
    'berlin-wall-fall': {
      male: {
        en: "The Night the Wall Came Down",
        de: "Die Nacht, als die Mauer fiel",
        gsw: "D Nacht, wo d Muur gfalle isch",
        fr: "La nuit où le mur est tombé",
        it: "La notte in cui il muro cadde"
      },
      female: {
        en: "The Night the Wall Came Down",
        de: "Die Nacht, als die Mauer fiel",
        gsw: "D Nacht, wo d Muur gfalle isch",
        fr: "La nuit où le mur est tombé",
        it: "La notte in cui il muro cadde"
      }
    },
    'mandela-freedom': {
      male: {
        en: "The Long Walk to Freedom",
        de: "Der lange Weg zur Freiheit",
        gsw: "De lang Wäg zur Freiheit",
        fr: "La longue marche vers la liberté",
        it: "La lunga strada verso la libertà"
      },
      female: {
        en: "The Long Walk to Freedom",
        de: "Der lange Weg zur Freiheit",
        gsw: "De lang Wäg zur Freiheit",
        fr: "La longue marche vers la liberté",
        it: "La lunga strada verso la libertà"
      }
    },

    // ── Great Constructions ────────────────────────────────────────
    'pyramids': {
      male: {
        en: "The Boy Who Touched the Sky with Stones",
        de: "Der Junge, der mit Steinen den Himmel berührte",
        gsw: "De Bueb, wo mit Stei de Himmel berüehrt het",
        fr: "Le garçon qui toucha le ciel avec des pierres",
        it: "Il ragazzo che toccò il cielo con le pietre"
      },
      female: {
        en: "The Girl Who Touched the Sky with Stones",
        de: "Das Mädchen, das mit Steinen den Himmel berührte",
        gsw: "S Meitli, wo mit Stei de Himmel berüehrt het",
        fr: "La fille qui toucha le ciel avec des pierres",
        it: "La ragazza che toccò il cielo con le pietre"
      }
    },
    'eiffel-tower': {
      male: {
        en: "The Iron Giant of Paris",
        de: "Der Eisenriese von Paris",
        gsw: "De Iiseriis vo Paris",
        fr: "Le géant de fer de Paris",
        it: "Il gigante di ferro di Parigi"
      },
      female: {
        en: "The Iron Giant of Paris",
        de: "Der Eisenriese von Paris",
        gsw: "De Iiseriis vo Paris",
        fr: "Le géant de fer de Paris",
        it: "Il gigante di ferro di Parigi"
      }
    },
    'panama-canal': {
      male: {
        en: "The River Between Two Oceans",
        de: "Der Fluss zwischen zwei Ozeanen",
        gsw: "De Fluss zwüsche zwöi Ozeane",
        fr: "La rivière entre deux océans",
        it: "Il fiume tra due oceani"
      },
      female: {
        en: "The River Between Two Oceans",
        de: "Der Fluss zwischen zwei Ozeanen",
        gsw: "De Fluss zwüsche zwöi Ozeane",
        fr: "La rivière entre deux océans",
        it: "Il fiume tra due oceani"
      }
    },
    'golden-gate': {
      male: {
        en: "The Bridge Above the Fog",
        de: "Die Brücke über dem Nebel",
        gsw: "D Brugg über em Näbel",
        fr: "Le pont au-dessus du brouillard",
        it: "Il ponte sopra la nebbia"
      },
      female: {
        en: "The Bridge Above the Fog",
        de: "Die Brücke über dem Nebel",
        gsw: "D Brugg über em Näbel",
        fr: "Le pont au-dessus du brouillard",
        it: "Il ponte sopra la nebbia"
      }
    },
    'channel-tunnel': {
      male: {
        en: "The Tunnel Under the Sea",
        de: "Der Tunnel unter dem Meer",
        gsw: "De Tunnel unterm Meer",
        fr: "Le tunnel sous la mer",
        it: "Il tunnel sotto il mare"
      },
      female: {
        en: "The Tunnel Under the Sea",
        de: "Der Tunnel unter dem Meer",
        gsw: "De Tunnel unterm Meer",
        fr: "Le tunnel sous la mer",
        it: "Il tunnel sotto il mare"
      }
    },

    // ── Culture & Arts ─────────────────────────────────────────────
    'first-olympics': {
      male: {
        en: "The Fastest Boy in Ancient Greece",
        de: "Der schnellste Junge im alten Griechenland",
        gsw: "De schnällscht Bueb im alte Griecheland",
        fr: "Le garçon le plus rapide de la Grèce antique",
        it: "Il ragazzo più veloce dell'antica Grecia"
      },
      female: {
        en: "The Fastest Girl in Ancient Greece",
        de: "Das schnellste Mädchen im alten Griechenland",
        gsw: "S schnällschte Meitli im alte Griecheland",
        fr: "La fille la plus rapide de la Grèce antique",
        it: "La ragazza più veloce dell'antica Grecia"
      }
    },
    'disneyland-opening': {
      male: {
        en: "The Day the Dream Park Opened",
        de: "Der Tag, als der Traumpark öffnete",
        gsw: "De Tag, wo de Traumpark ufgmacht het",
        fr: "Le jour où le parc des rêves a ouvert",
        it: "Il giorno in cui il parco dei sogni aprì"
      },
      female: {
        en: "The Day the Dream Park Opened",
        de: "Der Tag, als der Traumpark öffnete",
        gsw: "De Tag, wo de Traumpark ufgmacht het",
        fr: "Le jour où le parc des rêves a ouvert",
        it: "Il giorno in cui il parco dei sogni aprì"
      }
    },
    'first-movie': {
      male: {
        en: "The Night the Pictures Came Alive",
        de: "Die Nacht, in der die Bilder lebendig wurden",
        gsw: "D Nacht, wo d Bilder läbendig worde sind",
        fr: "La nuit où les images prirent vie",
        it: "La notte in cui le immagini presero vita"
      },
      female: {
        en: "The Night the Pictures Came Alive",
        de: "Die Nacht, in der die Bilder lebendig wurden",
        gsw: "D Nacht, wo d Bilder läbendig worde sind",
        fr: "La nuit où les images prirent vie",
        it: "La notte in cui le immagini presero vita"
      }
    },
    'first-zoo': {
      male: {
        en: "The Garden of a Thousand Animals",
        de: "Der Garten der tausend Tiere",
        gsw: "De Garte vo de tuusig Tier",
        fr: "Le jardin aux mille animaux",
        it: "Il giardino dei mille animali"
      },
      female: {
        en: "The Garden of a Thousand Animals",
        de: "Der Garten der tausend Tiere",
        gsw: "De Garte vo de tuusig Tier",
        fr: "Le jardin aux mille animaux",
        it: "Il giardino dei mille animali"
      }
    },
    'natural-history-museum': {
      male: {
        en: "The Palace of Wonders",
        de: "Der Palast der Wunder",
        gsw: "De Palascht vo de Wunder",
        fr: "Le palais des merveilles",
        it: "Il palazzo delle meraviglie"
      },
      female: {
        en: "The Palace of Wonders",
        de: "Der Palast der Wunder",
        gsw: "De Palascht vo de Wunder",
        fr: "Le palais des merveilles",
        it: "Il palazzo delle meraviglie"
      }
    },

    // ── Archaeological Discoveries ─────────────────────────────────
    'king-tut': {
      male: {
        en: "The Boy King's Hidden Treasure",
        de: "Der verborgene Schatz des jungen Königs",
        gsw: "De verborgeni Schatz vom junge König",
        fr: "Le trésor caché du roi enfant",
        it: "Il tesoro nascosto del re bambino"
      },
      female: {
        en: "The Boy King's Hidden Treasure",
        de: "Der verborgene Schatz des jungen Königs",
        gsw: "De verborgeni Schatz vom junge König",
        fr: "Le trésor caché du roi enfant",
        it: "Il tesoro nascosto del re bambino"
      }
    },
    'pompeii-discovery': {
      male: {
        en: "The City Frozen in Time",
        de: "Die Stadt, die in der Zeit erstarrte",
        gsw: "D Stadt, wo i de Zyt erstarrt isch",
        fr: "La cité figée dans le temps",
        it: "La città cristallizzata nel tempo"
      },
      female: {
        en: "The City Frozen in Time",
        de: "Die Stadt, die in der Zeit erstarrte",
        gsw: "D Stadt, wo i de Zyt erstarrt isch",
        fr: "La cité figée dans le temps",
        it: "La città cristallizzata nel tempo"
      }
    },
    'terracotta-army': {
      male: {
        en: "The Emperor's Stone Soldiers",
        de: "Die steinernen Soldaten des Kaisers",
        gsw: "D steinige Soldate vom Kaiser",
        fr: "Les soldats de pierre de l'empereur",
        it: "I soldati di pietra dell'imperatore"
      },
      female: {
        en: "The Emperor's Stone Soldiers",
        de: "Die steinernen Soldaten des Kaisers",
        gsw: "D steinige Soldate vom Kaiser",
        fr: "Les soldats de pierre de l'empereur",
        it: "I soldati di pietra dell'imperatore"
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
