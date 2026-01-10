/**
 * Historical Events for Children's Stories
 *
 * Each event includes comprehensive historical context to ensure
 * stories are historically accurate, not freely invented.
 *
 * Events are non-war related and age-appropriate for children.
 */

const HISTORICAL_EVENTS = {
  // ============================================
  // EXPLORATION & DISCOVERY
  // ============================================

  'moon-landing': {
    id: 'moon-landing',
    name: 'First Moon Landing',
    shortName: 'Moon Landing',
    year: 1969,
    date: 'July 20, 1969',
    location: 'Moon (Sea of Tranquility)',
    category: 'exploration',

    keyFigures: [
      { name: 'Neil Armstrong', role: 'Commander, first person on the Moon', nationality: 'American' },
      { name: 'Buzz Aldrin', role: 'Lunar Module Pilot, second person on the Moon', nationality: 'American' },
      { name: 'Michael Collins', role: 'Command Module Pilot, orbited the Moon', nationality: 'American' }
    ],

    historicalContext: `
      The Apollo 11 mission was the culmination of the Space Race between the USA and Soviet Union.
      President John F. Kennedy had promised in 1961 that America would land a man on the Moon before
      the decade was out. Over 400,000 engineers, scientists, and workers contributed to the Apollo program.

      The astronauts launched from Kennedy Space Center in Florida aboard a Saturn V rocket, the most
      powerful rocket ever built. The journey to the Moon took about 3 days. Neil Armstrong and Buzz Aldrin
      descended to the surface in the Lunar Module "Eagle" while Michael Collins orbited above in the
      Command Module "Columbia."

      Armstrong's first words on the Moon were: "That's one small step for man, one giant leap for mankind."
      The astronauts spent about 2.5 hours outside, collecting lunar samples and planting an American flag.
      They left a plaque reading: "Here men from the planet Earth first set foot upon the Moon. July 1969 A.D.
      We came in peace for all mankind."
    `,

    periodCostumes: {
      astronauts: 'White NASA spacesuits with American flag patches, bubble helmets, life support backpacks',
      missionControl: '1960s business attire - white short-sleeve dress shirts, thin ties, horn-rimmed glasses',
      civilians: '1960s American fashion - women in shift dresses, men in suits with narrow lapels'
    },

    keyLocations: ['Kennedy Space Center, Florida', 'Mission Control, Houston', 'Moon surface', 'Inside spacecraft'],

    storyAngles: [
      'A child watching the Moon landing on TV with their family',
      'The son/daughter of a NASA engineer during the mission',
      'Dreaming of becoming an astronaut after watching the landing',
      'The journey from Earth to Moon from astronaut perspective'
    ],

    historicalDetails: {
      technology: 'Saturn V rocket, Lunar Module Eagle, Command Module Columbia, 1960s computers less powerful than a modern calculator',
      food: 'Freeze-dried food in pouches, Tang orange drink',
      communication: 'Radio communication with 1.3 second delay between Earth and Moon',
      duration: '8 days total mission, 21 hours on lunar surface'
    },

    ageAppropriate: true,
    themes: ['courage', 'teamwork', 'human achievement', 'exploration', 'dreams coming true']
  },

  'columbus-voyage': {
    id: 'columbus-voyage',
    name: 'Columbus Reaches the Americas',
    shortName: 'Discovery of America',
    year: 1492,
    date: 'October 12, 1492',
    location: 'Bahamas (San Salvador)',
    category: 'exploration',

    keyFigures: [
      { name: 'Christopher Columbus', role: 'Explorer and navigator', nationality: 'Italian (Genoese), sailing for Spain' },
      { name: 'Queen Isabella I', role: 'Queen of Castile, funded the voyage', nationality: 'Spanish' },
      { name: 'King Ferdinand II', role: 'King of Aragon, co-sponsor', nationality: 'Spanish' }
    ],

    historicalContext: `
      Christopher Columbus believed he could reach Asia by sailing west across the Atlantic Ocean.
      After being rejected by Portugal, he convinced Queen Isabella and King Ferdinand of Spain to
      fund his expedition. He set sail on August 3, 1492, with three ships: the Nina, the Pinta, and
      the Santa Maria, and a crew of about 90 men.

      The voyage was difficult - many sailors feared falling off the edge of the Earth or being lost
      at sea forever. After 36 days of sailing, a lookout on the Pinta spotted land. Columbus landed
      on an island he named San Salvador, believing he had reached the Indies (Asia). He called the
      native Taino people "Indians."

      Though Columbus never realized he had found a "New World," his voyages opened the way for
      European exploration and the Columbian Exchange of plants, animals, and ideas between continents.
      Note: The arrival also had devastating consequences for indigenous peoples through disease and colonization.
    `,

    periodCostumes: {
      sailors: 'Simple wool tunics, loose trousers, bare feet or leather shoes, cloth caps',
      columbus: 'Renaissance nobleman attire - doublet, hose, cape, feathered hat',
      royalty: 'Elaborate Spanish court dress - brocade gowns, crowns, jeweled accessories',
      natives: 'Taino people wore simple cotton garments, body paint, feather and shell ornaments'
    },

    keyLocations: ['Port of Palos, Spain', 'Aboard the Santa Maria', 'Atlantic Ocean', 'San Salvador island'],

    storyAngles: [
      'A young cabin boy on his first voyage',
      'The excitement and fear of sailing into the unknown',
      'Spotting land after weeks at sea',
      'Meeting people from a completely different culture'
    ],

    historicalDetails: {
      ships: 'Nina (smallest, most nimble), Pinta (fastest), Santa Maria (largest, Columbus flagship)',
      navigation: 'Compass, astrolabe, dead reckoning, stars',
      food: 'Salted meat, hardtack biscuits, dried fish, water and wine in barrels',
      duration: '36 days from Canary Islands to the Bahamas'
    },

    ageAppropriate: true,
    themes: ['courage', 'perseverance', 'curiosity', 'facing the unknown']
  },

  'wright-brothers': {
    id: 'wright-brothers',
    name: 'First Powered Flight',
    shortName: 'First Airplane Flight',
    year: 1903,
    date: 'December 17, 1903',
    location: 'Kitty Hawk, North Carolina, USA',
    category: 'invention',

    keyFigures: [
      { name: 'Orville Wright', role: 'Pilot of first flight, co-inventor', nationality: 'American' },
      { name: 'Wilbur Wright', role: 'Co-inventor of the airplane', nationality: 'American' }
    ],

    historicalContext: `
      Wilbur and Orville Wright were bicycle mechanics from Dayton, Ohio, who became obsessed with
      the dream of human flight. They studied birds, built their own wind tunnel, and tested over
      200 wing designs. Unlike other inventors who focused on powerful engines, the Wrights realized
      the key was controlling the aircraft in flight.

      They invented "wing warping" - twisting the wings to turn and balance the plane. They chose
      Kitty Hawk, North Carolina for its steady winds and soft sandy landing surface. After years
      of glider tests, they added a lightweight gasoline engine they built themselves.

      On December 17, 1903, Orville made the first powered flight, lasting 12 seconds and covering
      120 feet. They made four flights that day, with the longest lasting 59 seconds and covering
      852 feet. The age of aviation had begun, though few newspapers reported it and many didn't
      believe it was true for years.
    `,

    periodCostumes: {
      wrightBrothers: 'Turn-of-century work clothes - wool suits, ties, flat caps, leather shoes',
      spectators: 'Early 1900s American dress - long skirts for women, three-piece suits for men',
      helpers: 'Working class attire - overalls, suspenders, work boots'
    },

    keyLocations: ['Wright bicycle shop, Dayton, Ohio', 'Kitty Hawk beach', 'Kill Devil Hills'],

    storyAngles: [
      'The brothers testing gliders and learning from failures',
      'The excitement of the first successful flight',
      'A local child watching the strange flying machine',
      'The dream of flying and making it real through hard work'
    ],

    historicalDetails: {
      aircraft: 'Wright Flyer - wooden frame, muslin fabric wings, 12 horsepower engine, no wheels (used launch rail)',
      weather: 'Cold December day, 27 mph winds',
      witnesses: 'Five local witnesses, famous photograph by John T. Daniels',
      preparation: 'Years of glider experiments, over 1000 test flights'
    },

    ageAppropriate: true,
    themes: ['perseverance', 'innovation', 'dreaming big', 'learning from failure', 'teamwork']
  },

  'lindbergh-flight': {
    id: 'lindbergh-flight',
    name: 'First Solo Transatlantic Flight',
    shortName: 'Lindbergh Crosses Atlantic',
    year: 1927,
    date: 'May 20-21, 1927',
    location: 'New York to Paris',
    category: 'exploration',

    keyFigures: [
      { name: 'Charles Lindbergh', role: 'Pilot, nicknamed "Lucky Lindy" and "The Lone Eagle"', nationality: 'American' }
    ],

    historicalContext: `
      In 1919, a $25,000 prize was offered for the first nonstop flight between New York and Paris.
      Several famous pilots had died trying. Charles Lindbergh, a 25-year-old airmail pilot, convinced
      St. Louis businessmen to fund a specially designed plane called the "Spirit of St. Louis."

      The plane was built for range, not comfort. It had no front windshield (replaced by a fuel tank),
      no radio, no parachute. Lindbergh could only see forward through a periscope or by turning sideways.
      He took off from Roosevelt Field, Long Island, with 451 gallons of fuel.

      The 33.5-hour flight was exhausting. Lindbergh battled sleep, icing on the wings, and navigation
      challenges. He flew low over fishing boats near Ireland to confirm his direction. When he landed
      at Le Bourget airfield near Paris, 150,000 people rushed to greet him. He became the most famous
      person in the world overnight, and aviation captured the public imagination.
    `,

    periodCostumes: {
      lindbergh: 'Leather flight jacket, jodhpurs, leather boots, flight goggles, leather helmet',
      parisianCrowd: '1920s French fashion - cloche hats, dropped-waist dresses, men in suits and caps',
      americanCrowd: '1920s American fashion - flapper dresses, fedora hats, suspenders'
    },

    keyLocations: ['Roosevelt Field, New York', 'Inside Spirit of St. Louis cockpit', 'Over the Atlantic', 'Le Bourget airfield, Paris'],

    storyAngles: [
      'The long lonely hours over the ocean',
      'Fighting to stay awake through the night',
      'The moment of seeing the coast of Ireland',
      'The incredible welcome in Paris'
    ],

    historicalDetails: {
      aircraft: 'Spirit of St. Louis - single engine, single seat, 46-foot wingspan',
      distance: '3,600 miles (5,800 km)',
      duration: '33 hours 30 minutes',
      preparation: 'Only 5 sandwiches, 2 canteens of water, no sleep the night before'
    },

    ageAppropriate: true,
    themes: ['courage', 'determination', 'solo achievement', 'overcoming fear']
  },

  'everest-summit': {
    id: 'everest-summit',
    name: 'First Summit of Mount Everest',
    shortName: 'Climbing Everest',
    year: 1953,
    date: 'May 29, 1953',
    location: 'Mount Everest, Nepal/Tibet',
    category: 'exploration',

    keyFigures: [
      { name: 'Edmund Hillary', role: 'New Zealand mountaineer', nationality: 'New Zealander' },
      { name: 'Tenzing Norgay', role: 'Sherpa mountaineer and guide', nationality: 'Nepali/Tibetan' }
    ],

    historicalContext: `
      Mount Everest, at 29,032 feet (8,849 meters), is Earth's highest mountain. Many expeditions
      had tried and failed to reach the summit since the 1920s, with some climbers dying in the
      attempt. The mountain was considered almost impossible to climb.

      The 1953 British expedition, led by John Hunt, used a careful strategy of establishing camps
      at higher and higher altitudes. Edmund Hillary, a New Zealand beekeeper and mountaineer, and
      Tenzing Norgay, an experienced Sherpa guide, were chosen for the final summit attempt.

      On May 29, they left their highest camp at 27,900 feet. They had to climb a steep rock face
      now called the "Hillary Step." At 11:30 AM, they stood on top of the world. Hillary took a
      photograph of Tenzing holding flags, but there is no photo of Hillary on the summit. They
      spent only 15 minutes at the top before the dangerous descent. News reached Britain on the
      morning of Queen Elizabeth II's coronation, adding to the national celebration.
    `,

    periodCostumes: {
      climbers: '1950s mountaineering gear - wool layers, down jackets, leather boots with crampons, goggles, oxygen masks',
      sherpas: 'Traditional Tibetan/Nepali mountain clothing with modern climbing equipment',
      basecamp: 'British expedition clothing - wool sweaters, tweed, expedition parkas'
    },

    keyLocations: ['Base Camp, Nepal', 'Various camps up the mountain', 'Hillary Step', 'Summit of Everest'],

    storyAngles: [
      'The friendship between Hillary and Tenzing',
      'The final push to the summit',
      'Sherpa culture and mountain traditions',
      'Overcoming the "impossible" mountain'
    ],

    historicalDetails: {
      equipment: 'Primitive oxygen systems, hemp ropes, leather boots, wool clothing',
      challenges: 'Thin air (1/3 oxygen), extreme cold (-40°F), avalanches, crevasses',
      teamwork: '400 porters, 20 Sherpas, 13 climbers in the expedition',
      aftermath: 'Hillary knighted, Tenzing received George Medal'
    },

    ageAppropriate: true,
    themes: ['teamwork', 'perseverance', 'friendship across cultures', 'achieving the impossible']
  },

  'south-pole': {
    id: 'south-pole',
    name: 'First to the South Pole',
    shortName: 'Reaching the South Pole',
    year: 1911,
    date: 'December 14, 1911',
    location: 'South Pole, Antarctica',
    category: 'exploration',

    keyFigures: [
      { name: 'Roald Amundsen', role: 'Norwegian explorer, first to reach the South Pole', nationality: 'Norwegian' },
      { name: 'Robert Falcon Scott', role: 'British explorer, reached pole 34 days later', nationality: 'British' }
    ],

    historicalContext: `
      The race to the South Pole was one of the great adventures of the early 20th century. Both
      Amundsen's Norwegian team and Scott's British team set out in 1911 to be the first to reach
      the southernmost point on Earth.

      Amundsen was an experienced polar explorer who used dog sleds and skis, methods learned from
      the Inuit. His team was small, efficient, and well-prepared. They established supply depots
      and moved quickly across the ice.

      On December 14, 1911, Amundsen and four companions reached the South Pole. They planted the
      Norwegian flag and left a tent with a letter for Scott. The return journey was smooth.

      Scott's team, using motor sledges, ponies, and man-hauling, reached the pole on January 17, 1912,
      only to find Amundsen's flag. Tragically, Scott and all four companions died on the return journey
      due to exhaustion, cold, and lack of supplies.
    `,

    periodCostumes: {
      norwegians: 'Inuit-style fur clothing, sealskin boots, wool underlayers, ski goggles',
      british: 'Wool and canvas clothing, leather boots, goggles, heavy parkas',
      dogs: 'Sled dogs with harnesses'
    },

    keyLocations: ['Base camp (Framheim for Norwegians)', 'Ross Ice Shelf', 'Polar plateau', 'South Pole'],

    storyAngles: [
      'The preparation and planning for the expedition',
      'Life with the sled dogs',
      'The moment of reaching the pole',
      'Learning from different approaches to exploration'
    ],

    historicalDetails: {
      transport: 'Amundsen: 52 sled dogs, skis. Scott: motor sledges, ponies, man-hauling',
      distance: 'About 1,400 miles round trip',
      duration: 'Amundsen: 99 days round trip',
      conditions: 'Temperatures to -40°F, constant daylight, crevasses, blizzards'
    },

    ageAppropriate: true,
    themes: ['preparation', 'planning', 'respecting nature', 'learning from indigenous peoples']
  },

  'magellan-circumnavigation': {
    id: 'magellan-circumnavigation',
    name: 'First Circumnavigation of Earth',
    shortName: 'Sailing Around the World',
    year: 1522,
    date: '1519-1522',
    location: 'Worldwide voyage',
    category: 'exploration',

    keyFigures: [
      { name: 'Ferdinand Magellan', role: 'Portuguese explorer, led the expedition (died en route)', nationality: 'Portuguese, sailing for Spain' },
      { name: 'Juan Sebastian Elcano', role: 'Spanish navigator who completed the voyage', nationality: 'Spanish' }
    ],

    historicalContext: `
      Ferdinand Magellan set out to find a western route to the Spice Islands (Indonesia) by sailing
      around South America. On September 20, 1519, five ships and about 270 men departed from Spain.

      The expedition faced mutiny, starvation, and unknown waters. Magellan discovered the strait at
      the tip of South America (now called the Strait of Magellan) and crossed the Pacific Ocean,
      which he named for its calm waters. The Pacific crossing took 99 days with no fresh food.

      Magellan was killed in the Philippines in April 1521 during a battle with local warriors.
      Juan Sebastian Elcano took command and continued west. On September 6, 1522, the ship Victoria
      and 18 surviving crew members returned to Spain - the first humans to sail around the world.

      The voyage proved Earth was round and much larger than Europeans had thought. It also showed
      that all the world's oceans were connected.
    `,

    periodCostumes: {
      sailors: '16th century maritime clothing - loose shirts, knee breeches, bare feet, cloth caps',
      officers: 'Renaissance Spanish naval attire - doublets, ruffs, capes, plumed hats',
      natives: 'Various indigenous clothing from South America, Philippines - loincloths, feathers, tattoos'
    },

    keyLocations: ['Seville, Spain', 'Strait of Magellan', 'Pacific Ocean', 'Philippines', 'Spice Islands'],

    storyAngles: [
      'A young sailor experiencing the unknown',
      'Discovering the strait through South America',
      'The long Pacific crossing',
      'The joy of returning home after three years'
    ],

    historicalDetails: {
      ships: 'Trinidad, San Antonio, Concepcion, Victoria, Santiago (only Victoria returned)',
      crew: '270 departed, 18 returned',
      distance: 'About 42,000 miles',
      duration: 'Nearly 3 years (1,084 days)'
    },

    ageAppropriate: true,
    themes: ['perseverance', 'discovery', 'courage', 'proving the impossible possible']
  },

  'mariana-trench': {
    id: 'mariana-trench',
    name: 'First Dive to the Deepest Ocean',
    shortName: 'Mariana Trench Dive',
    year: 1960,
    date: 'January 23, 1960',
    location: 'Challenger Deep, Mariana Trench, Pacific Ocean',
    category: 'exploration',

    keyFigures: [
      { name: 'Jacques Piccard', role: 'Swiss oceanographer and engineer', nationality: 'Swiss' },
      { name: 'Don Walsh', role: 'US Navy Lieutenant', nationality: 'American' }
    ],

    historicalContext: `
      The Mariana Trench is the deepest part of the ocean, deeper than Mount Everest is tall.
      The Challenger Deep reaches nearly 36,000 feet (11,000 meters) below sea level. At that
      depth, the pressure is over 1,000 times greater than at the surface.

      The bathyscaphe Trieste, designed by Auguste Piccard (Jacques's father), was built to
      withstand this crushing pressure. It had a small steel sphere for the crew attached to a
      large float filled with gasoline for buoyancy.

      On January 23, 1960, Piccard and Walsh began their descent. It took nearly 5 hours to reach
      the bottom. At the deepest point, they observed fish and shrimp - proving life exists even
      in the most extreme conditions. They spent 20 minutes on the bottom before ascending.

      The dive was not repeated until 2012 when filmmaker James Cameron made a solo dive.
    `,

    periodCostumes: {
      crew: '1960s naval and scientific attire - khaki uniforms, work clothes',
      support: 'US Navy sailors in dress whites and work uniforms'
    },

    keyLocations: ['USS Lewis support ship', 'Inside Trieste bathyscaphe', 'Challenger Deep seafloor'],

    storyAngles: [
      'Descending into total darkness',
      'The strange creatures of the deep',
      'The bravery of exploring the unknown',
      'Comparing deep sea to outer space'
    ],

    historicalDetails: {
      vessel: 'Bathyscaphe Trieste - gasoline-filled float, steel pressure sphere',
      depth: '35,814 feet (10,916 meters)',
      pressure: '16,000 psi (1,000 times surface pressure)',
      descent: '4 hours 47 minutes down, 3 hours 15 minutes up'
    },

    ageAppropriate: true,
    themes: ['curiosity', 'bravery', 'scientific discovery', 'exploring Earth\'s mysteries']
  },

  // ============================================
  // SCIENCE & INVENTION
  // ============================================

  'electricity-discovery': {
    id: 'electricity-discovery',
    name: 'Franklin\'s Kite Experiment',
    shortName: 'Discovering Electricity',
    year: 1752,
    date: 'June 1752',
    location: 'Philadelphia, Pennsylvania',
    category: 'science',

    keyFigures: [
      { name: 'Benjamin Franklin', role: 'Scientist, inventor, and Founding Father', nationality: 'American' },
      { name: 'William Franklin', role: 'Benjamin\'s son who helped with experiment', nationality: 'American' }
    ],

    historicalContext: `
      Benjamin Franklin was curious about everything. He noticed that lightning looked like the
      electrical sparks created in laboratories, and wondered if they were the same thing.

      In June 1752, during a thunderstorm, Franklin flew a kite with a metal key attached to the
      string. When the wet string conducted electricity from the clouds, he felt a spark from the
      key. This proved that lightning was electrical.

      WARNING: This experiment was extremely dangerous - Franklin was lucky not to be killed.
      Other scientists who tried to repeat it were electrocuted.

      Based on his discovery, Franklin invented the lightning rod - a metal pole that safely
      conducts lightning to the ground, protecting buildings from fire. This invention has saved
      countless lives and buildings. Franklin chose not to patent it, wanting everyone to benefit.
    `,

    periodCostumes: {
      franklin: 'Colonial American gentleman attire - coat, waistcoat, knee breeches, buckled shoes, spectacles',
      colonials: '1750s American dress - simple wool and linen clothing, tricorn hats for men, bonnets for women'
    },

    keyLocations: ['Philadelphia street', 'Franklin\'s workshop', 'Open field during storm'],

    storyAngles: [
      'Franklin\'s curiosity about nature',
      'The excitement of the discovery',
      'Inventing the lightning rod to help people',
      'Sharing knowledge freely with everyone'
    ],

    historicalDetails: {
      kite: 'Silk kite with metal point, hemp string, silk ribbon insulator, iron key',
      danger: 'Extremely dangerous - others died attempting this',
      invention: 'Lightning rod - still used today',
      franklin: 'Also invented bifocals, the Franklin stove, swim fins'
    },

    ageAppropriate: true,
    themes: ['curiosity', 'scientific method', 'helping others', 'danger of experiments']
  },

  'telephone-invention': {
    id: 'telephone-invention',
    name: 'First Telephone Call',
    shortName: 'Invention of Telephone',
    year: 1876,
    date: 'March 10, 1876',
    location: 'Boston, Massachusetts, USA',
    category: 'invention',

    keyFigures: [
      { name: 'Alexander Graham Bell', role: 'Inventor of the telephone', nationality: 'Scottish-American' },
      { name: 'Thomas Watson', role: 'Bell\'s assistant', nationality: 'American' }
    ],

    historicalContext: `
      Alexander Graham Bell was a teacher of the deaf whose mother and wife were both deaf. His
      knowledge of sound and speech led him to experiment with transmitting voice over wires.

      On March 10, 1876, Bell was in one room and his assistant Thomas Watson was in another,
      connected by wire. Bell spilled some acid and called out, "Mr. Watson, come here, I want
      to see you!" Watson heard the words clearly through the device - the first telephone call.

      Bell patented the telephone just hours before a rival inventor. The telephone would transform
      human communication, allowing people to speak across vast distances instantly. Bell refused
      to have a telephone in his study, finding it intrusive!

      Bell also worked on helping deaf people communicate and founded institutions for the deaf.
    `,

    periodCostumes: {
      inventors: 'Victorian era professional attire - three-piece suits, bow ties, waistcoats',
      victorians: '1870s fashion - bustle dresses for women, top hats and frock coats for men'
    },

    keyLocations: ['Bell\'s laboratory in Boston', 'Victorian-era workshop'],

    storyAngles: [
      'Bell\'s work helping deaf people that led to the invention',
      'The accident that led to the first call',
      'Watson hearing words through the wire for the first time',
      'Imagining how the telephone would change the world'
    ],

    historicalDetails: {
      firstWords: '"Mr. Watson, come here, I want to see you!"',
      patent: 'Filed just hours before rival Elisha Gray',
      dedication: 'Bell spent profits helping deaf education',
      later: 'Bell also invented early metal detector'
    },

    ageAppropriate: true,
    themes: ['helping others', 'accidental discovery', 'perseverance', 'communication']
  },

  'light-bulb': {
    id: 'light-bulb',
    name: 'Edison\'s Electric Light Bulb',
    shortName: 'The Light Bulb',
    year: 1879,
    date: 'October 21, 1879',
    location: 'Menlo Park, New Jersey, USA',
    category: 'invention',

    keyFigures: [
      { name: 'Thomas Edison', role: 'Inventor and businessman', nationality: 'American' }
    ],

    historicalContext: `
      Thomas Edison was known as "The Wizard of Menlo Park" for his incredible inventions.
      While he didn't invent the first electric light, he created the first PRACTICAL light bulb
      that would last long enough for everyday use.

      Edison and his team tested over 3,000 different materials for the filament (the part that
      glows). After cotton thread, fishing line, and even hair from his workers' beards, he
      discovered that carbonized bamboo could glow for over 1,200 hours.

      On October 21, 1879, the bulb with a carbon filament burned for 13.5 hours - a breakthrough.
      Edison then had to invent everything else needed for electric light: power stations,
      electrical wires, switches, and meters. In 1882, he lit up part of New York City.

      Edison famously said: "I have not failed. I've just found 10,000 ways that won't work."
    `,

    periodCostumes: {
      edison: 'Late Victorian work clothes - vest, rolled sleeves, bow tie, sometimes disheveled from work',
      workers: 'Working class attire - aprons, work boots, suspenders',
      victorians: '1880s fashion - high collars, long dresses, top hats'
    },

    keyLocations: ['Menlo Park laboratory', 'New York City (first electrical grid)'],

    storyAngles: [
      'The many failures before success',
      'Testing thousands of materials',
      'The moment the light stayed on',
      'Lighting up New York City for the first time'
    ],

    historicalDetails: {
      failures: 'Over 3,000 materials tested',
      success: 'Carbonized bamboo filament',
      duration: 'First successful bulb burned 13.5 hours',
      quote: '"I have not failed. I\'ve just found 10,000 ways that won\'t work."'
    },

    ageAppropriate: true,
    themes: ['perseverance', 'learning from failure', 'hard work', 'changing the world']
  },

  'penicillin': {
    id: 'penicillin',
    name: 'Discovery of Penicillin',
    shortName: 'Penicillin Discovery',
    year: 1928,
    date: 'September 1928',
    location: 'London, England',
    category: 'science',

    keyFigures: [
      { name: 'Alexander Fleming', role: 'Scottish bacteriologist', nationality: 'Scottish' },
      { name: 'Howard Florey', role: 'Australian pathologist who developed penicillin for use', nationality: 'Australian' },
      { name: 'Ernst Chain', role: 'German-British biochemist who helped develop penicillin', nationality: 'German-British' }
    ],

    historicalContext: `
      Alexander Fleming was a messy scientist. In September 1928, he returned from vacation to find
      mold growing on a petri dish where he had been growing bacteria. Instead of throwing it away,
      he noticed something strange: the bacteria near the mold had died.

      The mold was Penicillium notatum, and it was producing a substance that killed bacteria.
      Fleming named it "penicillin" but couldn't figure out how to produce enough to test as medicine.

      In 1940, Howard Florey and Ernst Chain found a way to mass-produce penicillin. During World
      War II, it saved thousands of soldiers from dying of infected wounds. It was called a "miracle
      drug" and marked the beginning of modern antibiotics.

      All three scientists shared the 1945 Nobel Prize in Medicine.
    `,

    periodCostumes: {
      scientists: '1920s/1940s laboratory attire - white coats, round spectacles, ties',
      nurses: 'Traditional white nurse uniforms with caps',
      patients: 'Hospital gowns or 1940s civilian clothes'
    },

    keyLocations: ['St. Mary\'s Hospital laboratory, London', 'Oxford University laboratories'],

    storyAngles: [
      'The accidental discovery in a messy lab',
      'Noticing something others might have missed',
      'Saving lives with the new medicine',
      'The importance of curiosity'
    ],

    historicalDetails: {
      discovery: 'Mold accidentally contaminated a petri dish',
      mold: 'Penicillium notatum (from bread mold)',
      impact: 'First widely used antibiotic, saved millions of lives',
      nobelPrize: '1945, shared by Fleming, Florey, and Chain'
    },

    ageAppropriate: true,
    themes: ['accidental discovery', 'curiosity', 'observation', 'helping others']
  },

  'vaccine-discovery': {
    id: 'vaccine-discovery',
    name: 'First Vaccine',
    shortName: 'Smallpox Vaccine',
    year: 1796,
    date: 'May 14, 1796',
    location: 'Berkeley, Gloucestershire, England',
    category: 'science',

    keyFigures: [
      { name: 'Edward Jenner', role: 'English physician, "Father of Immunology"', nationality: 'English' },
      { name: 'James Phipps', role: '8-year-old boy, first person vaccinated', nationality: 'English' }
    ],

    historicalContext: `
      Smallpox was one of the deadliest diseases in history, killing millions and leaving survivors
      scarred. Edward Jenner, a country doctor, noticed that milkmaids who caught cowpox (a mild
      disease from cows) never seemed to get smallpox.

      On May 14, 1796, Jenner took material from a cowpox blister on milkmaid Sarah Nelmes and
      scratched it into the arm of 8-year-old James Phipps. James got a mild fever but recovered
      quickly. Six weeks later, Jenner exposed him to smallpox - and James didn't get sick!

      Jenner called his method "vaccination" from "vacca," the Latin word for cow. Despite initial
      ridicule (critics drew cartoons of people growing cow heads!), vaccination spread worldwide.

      In 1980, the World Health Organization declared smallpox completely eradicated - the only
      human disease ever eliminated through vaccination.
    `,

    periodCostumes: {
      jenner: 'Late Georgian physician attire - coat, waistcoat, breeches, powdered wig or natural hair',
      milkmaid: 'Simple country dress, apron, bonnet, bare arms for milking',
      villagers: 'Rural English clothing - wool and linen, simple styles'
    },

    keyLocations: ['Berkeley village', 'Jenner\'s home', 'Dairy farm', 'Medical offices'],

    storyAngles: [
      'Jenner listening to milkmaids\' stories',
      'The brave young James Phipps',
      'Overcoming ridicule from other doctors',
      'Saving millions of lives'
    ],

    historicalDetails: {
      disease: 'Smallpox killed 30% of those infected',
      method: 'Cowpox material scratched into skin',
      name: '"Vaccination" from Latin "vacca" (cow)',
      result: 'Smallpox eradicated in 1980'
    },

    ageAppropriate: true,
    themes: ['listening to others', 'bravery', 'scientific thinking', 'saving lives']
  },

  'dna-discovery': {
    id: 'dna-discovery',
    name: 'Discovery of DNA Structure',
    shortName: 'DNA Double Helix',
    year: 1953,
    date: 'February 28, 1953',
    location: 'Cambridge, England',
    category: 'science',

    keyFigures: [
      { name: 'James Watson', role: 'American biologist', nationality: 'American' },
      { name: 'Francis Crick', role: 'British physicist and biologist', nationality: 'British' },
      { name: 'Rosalind Franklin', role: 'British chemist whose X-ray images were crucial', nationality: 'British' }
    ],

    historicalContext: `
      Scientists knew that DNA (deoxyribonucleic acid) contained the instructions for life, but
      no one knew what it looked like. Understanding its structure would unlock the secrets of
      heredity - why children look like their parents.

      Rosalind Franklin used X-ray crystallography to create images of DNA. Her famous "Photo 51"
      showed a clear X-pattern. James Watson and Francis Crick at Cambridge used her data (without
      her full knowledge) along with their own work to build a model of DNA.

      On February 28, 1953, they announced they had discovered the structure: a double helix,
      like a twisted ladder. The "rungs" of the ladder are pairs of chemicals that encode genetic
      information. Crick famously announced at a local pub that they had "discovered the secret
      of life."

      Watson and Crick won the Nobel Prize in 1962. Franklin had died of cancer in 1958 and Nobel
      Prizes are not awarded posthumously. Her crucial contribution was not fully recognized for decades.
    `,

    periodCostumes: {
      scientists: '1950s academic attire - suits, ties, lab coats',
      franklin: '1950s professional women\'s attire - modest dresses, cardigans'
    },

    keyLocations: ['Cavendish Laboratory, Cambridge', 'King\'s College, London', 'The Eagle pub, Cambridge'],

    storyAngles: [
      'The race to solve the puzzle',
      'Building models to understand nature',
      'Rosalind Franklin\'s important work',
      'Understanding how life passes from parents to children'
    ],

    historicalDetails: {
      structure: 'Double helix - twisted ladder shape',
      photo51: 'Rosalind Franklin\'s crucial X-ray image',
      announcement: 'Crick at The Eagle pub: "We have discovered the secret of life"',
      nobelPrize: '1962, Watson, Crick, and Wilkins (Franklin had died)'
    },

    ageAppropriate: true,
    themes: ['teamwork', 'solving puzzles', 'unsung heroes', 'understanding nature']
  },

  'dinosaur-discovery': {
    id: 'dinosaur-discovery',
    name: 'First Dinosaur Named',
    shortName: 'Discovery of Dinosaurs',
    year: 1824,
    date: '1824',
    location: 'Oxfordshire, England',
    category: 'science',

    keyFigures: [
      { name: 'William Buckland', role: 'English geologist and paleontologist', nationality: 'English' },
      { name: 'Mary Anning', role: 'Fossil hunter who found many important specimens', nationality: 'English' },
      { name: 'Richard Owen', role: 'Scientist who invented the word "dinosaur"', nationality: 'English' }
    ],

    historicalContext: `
      For centuries, people found giant bones but didn't know what they were. Some thought they
      were dragon bones or bones of giants from the Bible. In 1824, William Buckland became the
      first person to scientifically describe a dinosaur, which he named Megalosaurus ("great lizard").

      Mary Anning, a working-class fossil hunter from Lyme Regis, made many important discoveries
      including ichthyosaurs and plesiosaurs. Despite her crucial contributions, as a woman she was
      not allowed to join scientific societies.

      In 1842, Richard Owen invented the word "dinosaur" meaning "terrible lizard" to describe these
      ancient creatures. He helped design the first life-size dinosaur models for the Crystal Palace
      in London, where they still stand today.

      Scientists now know dinosaurs lived from about 230 to 65 million years ago and that birds are
      living dinosaurs!
    `,

    periodCostumes: {
      scientists: 'Early Victorian academic dress - frock coats, top hats, cravats',
      anning: 'Working class Regency/Victorian dress - simple gown, bonnet, sturdy boots for fossil hunting',
      workers: 'Laborers\' clothing - rough wool, leather aprons'
    },

    keyLocations: ['Lyme Regis cliffs', 'Oxford University', 'Crystal Palace, London'],

    storyAngles: [
      'Mary Anning hunting fossils on the cliffs',
      'Finding bones of creatures no one had seen before',
      'Imagining what these animals looked like when alive',
      'A world very different from our own'
    ],

    historicalDetails: {
      firstNamed: 'Megalosaurus, 1824',
      term: '"Dinosaur" coined 1842 by Richard Owen',
      maryAnning: 'Found first complete ichthyosaur at age 12',
      crystalPalace: 'First dinosaur sculptures, 1854'
    },

    ageAppropriate: true,
    themes: ['curiosity', 'discovery', 'persistence', 'women in science']
  },

  'einstein-relativity': {
    id: 'einstein-relativity',
    name: 'Einstein\'s Theory of Relativity',
    shortName: 'Einstein\'s Big Idea',
    year: 1905,
    date: '1905 (Miracle Year)',
    location: 'Bern, Switzerland',
    category: 'science',

    keyFigures: [
      { name: 'Albert Einstein', role: 'Physicist, developed theory of relativity', nationality: 'German-Swiss-American' }
    ],

    historicalContext: `
      In 1905, Albert Einstein was a 26-year-old patent clerk in Bern, Switzerland. He had failed
      to get an academic job but spent his spare time thinking about physics. That year, he published
      four papers that changed science forever - scientists call it his "Miracle Year."

      His most famous idea was that space and time are connected (spacetime), and that the speed of
      light is the fastest anything can travel. He showed that energy and mass are related with the
      famous equation E=mc² - a tiny amount of matter contains enormous energy.

      Einstein imagined riding on a beam of light to develop his ideas. He called these "thought
      experiments." His theories seemed crazy at first but have been proven correct many times.

      Einstein became the most famous scientist in history. He won the Nobel Prize in 1921. His wild
      hair and kind face became symbols of genius. He said imagination was more important than knowledge.
    `,

    periodCostumes: {
      einstein: 'Early 1900s clerk attire - suit, tie, later iconic wild hair and sweater',
      swiss: 'Edwardian era Swiss fashion - formal suits, dresses with high collars'
    },

    keyLocations: ['Swiss Patent Office, Bern', 'Einstein\'s small apartment', 'Princeton, New Jersey (later years)'],

    storyAngles: [
      'A young clerk with big ideas',
      'Imagining riding on a beam of light',
      'The importance of asking "what if?"',
      'Never giving up on your dreams'
    ],

    historicalDetails: {
      miracleYear: '1905 - published 4 revolutionary papers',
      equation: 'E=mc² (energy equals mass times speed of light squared)',
      nobelPrize: '1921 (for photoelectric effect, not relativity)',
      quote: '"Imagination is more important than knowledge"'
    },

    ageAppropriate: true,
    themes: ['imagination', 'thinking differently', 'perseverance', 'curiosity']
  },

  // ============================================
  // HUMAN RIGHTS & SOCIAL CHANGE
  // ============================================

  'emancipation': {
    id: 'emancipation',
    name: 'Abolition of Slavery in America',
    shortName: 'End of Slavery',
    year: 1865,
    date: 'December 6, 1865',
    location: 'United States',
    category: 'rights',

    keyFigures: [
      { name: 'Abraham Lincoln', role: '16th President, issued Emancipation Proclamation', nationality: 'American' },
      { name: 'Frederick Douglass', role: 'Former slave, abolitionist leader', nationality: 'American' },
      { name: 'Harriet Tubman', role: 'Former slave, Underground Railroad conductor', nationality: 'American' }
    ],

    historicalContext: `
      Slavery in America began in 1619 and lasted over 200 years. Enslaved African Americans were
      forced to work without pay, could be sold away from their families, and had no legal rights.
      Many fought for their freedom through rebellions, escape, and later through the legal system.

      The abolitionist movement grew stronger in the 1800s. Harriet Tubman escaped slavery and then
      risked her life 13 times to lead about 70 people to freedom via the Underground Railroad (a
      secret network of safe houses). Frederick Douglass, who taught himself to read while enslaved,
      became a powerful speaker and writer against slavery.

      In 1863, during the Civil War, President Lincoln issued the Emancipation Proclamation, freeing
      enslaved people in Confederate states. In 1865, the 13th Amendment to the Constitution abolished
      slavery everywhere in the United States.

      The struggle for full civil rights continued for another century and beyond.
    `,

    periodCostumes: {
      lincoln: 'Mid-19th century formal - black suit, stovepipe hat, bow tie',
      douglass: 'Distinguished 1850s-60s attire - suit, waistcoat',
      tubman: 'Simple working woman\'s dress, headscarf, practical shoes',
      enslaved: 'Simple homespun clothing - coarse fabric, no shoes'
    },

    keyLocations: ['White House', 'Underground Railroad safe houses', 'Southern plantations', 'Freedom destinations'],

    storyAngles: [
      'Harriet Tubman leading people to freedom',
      'Learning to read in secret',
      'The day freedom was announced',
      'Families reunited after slavery'
    ],

    historicalDetails: {
      duration: 'Slavery in America lasted over 200 years',
      tubman: 'Never lost a passenger on the Underground Railroad',
      amendment: '13th Amendment ratified December 6, 1865',
      continuation: 'Civil Rights struggle continued for 100+ more years'
    },

    ageAppropriate: true,
    themes: ['freedom', 'courage', 'helping others', 'justice', 'perseverance']
  },

  'womens-suffrage': {
    id: 'womens-suffrage',
    name: 'Women Win the Right to Vote',
    shortName: 'Women\'s Voting Rights',
    year: 1920,
    date: 'August 18, 1920',
    location: 'United States',
    category: 'rights',

    keyFigures: [
      { name: 'Susan B. Anthony', role: 'Suffragist leader', nationality: 'American' },
      { name: 'Elizabeth Cady Stanton', role: 'Women\'s rights activist', nationality: 'American' },
      { name: 'Alice Paul', role: 'Suffragist who organized protests', nationality: 'American' }
    ],

    historicalContext: `
      For most of American history, women could not vote. The women's suffrage movement began in
      1848 at the Seneca Falls Convention, where Elizabeth Cady Stanton read a Declaration of
      Sentiments modeled on the Declaration of Independence.

      Susan B. Anthony and Stanton led the movement for 50 years. Anthony was arrested for voting
      illegally in 1872. She never saw victory - she died in 1906. Her last public words were:
      "Failure is impossible."

      A new generation, led by Alice Paul, used more dramatic tactics including hunger strikes
      and protests outside the White House. Women were arrested and mistreated in jail, but they
      persisted.

      In 1920, the 19th Amendment was finally ratified, giving women the right to vote. The
      deciding vote came from a young Tennessee legislator who changed his vote after receiving
      a letter from his mother telling him to "be a good boy" and vote for suffrage.
    `,

    periodCostumes: {
      suffragists: 'White dresses with purple or yellow sashes (suffrage colors), large hats',
      edwardian: 'High collars, long skirts, elaborate hats with feathers',
      protesters: 'Simple practical dresses, banners reading "Votes for Women"'
    },

    keyLocations: ['Seneca Falls, NY', 'White House protests', 'Congress', 'Voting booths'],

    storyAngles: [
      'A girl watching her mother vote for the first time',
      'Suffragists marching for their rights',
      'A mother\'s letter changing history',
      'Never giving up on what\'s right'
    ],

    historicalDetails: {
      duration: '72 years from Seneca Falls to 19th Amendment',
      anthonyQuote: '"Failure is impossible"',
      colors: 'Purple, white, and gold/yellow were suffrage colors',
      decidingVote: 'Harry Burn changed his vote after his mother\'s letter'
    },

    ageAppropriate: true,
    themes: ['equality', 'perseverance', 'standing up for rights', 'never giving up']
  },

  'rosa-parks': {
    id: 'rosa-parks',
    name: 'Rosa Parks and the Bus Boycott',
    shortName: 'Rosa Parks\' Stand',
    year: 1955,
    date: 'December 1, 1955',
    location: 'Montgomery, Alabama, USA',
    category: 'rights',

    keyFigures: [
      { name: 'Rosa Parks', role: 'Civil rights activist', nationality: 'American' },
      { name: 'Martin Luther King Jr.', role: 'Baptist minister, civil rights leader', nationality: 'American' }
    ],

    historicalContext: `
      In 1955, Montgomery, Alabama had laws requiring Black passengers to give up their bus seats
      to white passengers. On December 1, Rosa Parks, a 42-year-old seamstress and NAACP activist,
      refused to give up her seat. She was arrested.

      Rosa Parks was not the first to resist bus segregation, but she was a respected community
      member whose case could rally support. Black community leaders, including young minister
      Martin Luther King Jr., organized a boycott of Montgomery buses.

      For 381 days, Black residents carpooled, walked (some up to 20 miles), or used other means
      to get to work. The bus company lost most of its revenue. Finally, the Supreme Court ruled
      that bus segregation was unconstitutional.

      The Montgomery Bus Boycott was a major victory and helped launch the Civil Rights Movement.
      Rosa Parks became known as "the mother of the civil rights movement."
    `,

    periodCostumes: {
      parks: '1950s modest dress - A-line dress, cardigan, small hat, glasses',
      civilians: '1950s American fashion - women in dresses, men in suits and hats',
      busDriver: 'Bus company uniform with cap'
    },

    keyLocations: ['Montgomery city bus', 'Holt Street Baptist Church', 'Streets of Montgomery', 'Supreme Court'],

    storyAngles: [
      'Rosa Parks\' quiet courage',
      'A community walking together',
      'Children participating in the boycott',
      'Standing up by sitting down'
    ],

    historicalDetails: {
      boycott: '381 days of refusing to ride buses',
      walking: 'Some people walked 20+ miles to work',
      victory: 'Supreme Court ruled bus segregation unconstitutional',
      quote: '"I was not tired physically... I was tired of giving in"'
    },

    ageAppropriate: true,
    themes: ['courage', 'community', 'standing up for what\'s right', 'peaceful protest']
  },

  'berlin-wall-fall': {
    id: 'berlin-wall-fall',
    name: 'Fall of the Berlin Wall',
    shortName: 'Berlin Wall Falls',
    year: 1989,
    date: 'November 9, 1989',
    location: 'Berlin, Germany',
    category: 'rights',

    keyFigures: [
      { name: 'Mikhail Gorbachev', role: 'Soviet leader who allowed change', nationality: 'Russian' },
      { name: 'The People of Berlin', role: 'Citizens who tore down the wall', nationality: 'German' }
    ],

    historicalContext: `
      After World War II, Germany was divided into democratic West Germany and communist East
      Germany. Berlin, though deep in East Germany, was also divided. In 1961, East Germany built
      a wall to stop people from fleeing to the West. Families were separated overnight.

      For 28 years, the Berlin Wall stood as a symbol of the "Iron Curtain" dividing Europe. East
      German guards had orders to shoot anyone trying to cross. At least 140 people died attempting
      to escape.

      By 1989, communist governments across Eastern Europe were falling. Peaceful protests grew in
      East Germany. On November 9, a confused announcement led East Germans to believe the border
      was open. Thousands rushed to the wall.

      Guards, overwhelmed, opened the gates. People climbed the wall, danced on it, and began
      tearing it apart with hammers and bare hands. Families separated for decades were reunited.
      Germany officially reunified in 1990.
    `,

    periodCostumes: {
      eastGermans: 'Simple, practical 1980s clothes - less variety than West',
      westGermans: '1980s fashion - bright colors, denim, shoulder pads',
      guards: 'East German military uniforms with distinctive caps'
    },

    keyLocations: ['Berlin Wall checkpoints', 'Brandenburg Gate', 'Streets of Berlin'],

    storyAngles: [
      'A family separated by the wall for decades',
      'The night the wall came down',
      'Children seeing relatives for the first time',
      'Strangers hugging strangers in celebration'
    ],

    historicalDetails: {
      duration: 'Wall stood for 28 years (1961-1989)',
      deaths: 'At least 140 people killed trying to cross',
      reunification: 'Germany officially reunified October 3, 1990',
      pieces: 'Pieces of the wall are now in museums worldwide'
    },

    ageAppropriate: true,
    themes: ['freedom', 'family', 'hope', 'peaceful change', 'unity']
  },

  'mandela-freedom': {
    id: 'mandela-freedom',
    name: 'Nelson Mandela Released from Prison',
    shortName: 'Mandela Walks Free',
    year: 1990,
    date: 'February 11, 1990',
    location: 'Cape Town, South Africa',
    category: 'rights',

    keyFigures: [
      { name: 'Nelson Mandela', role: 'Anti-apartheid leader, later President', nationality: 'South African' },
      { name: 'Winnie Mandela', role: 'Activist, kept the movement alive', nationality: 'South African' },
      { name: 'F.W. de Klerk', role: 'President who released Mandela', nationality: 'South African' }
    ],

    historicalContext: `
      South Africa had a system called apartheid (meaning "apartness") that separated people by
      race. Black South Africans had few rights and were forced to live in poor areas. Nelson
      Mandela, a lawyer, led peaceful and later armed resistance against this injustice.

      In 1964, Mandela was sentenced to life in prison. For 27 years, he was held on Robben Island
      and later in other prisons. But he became a symbol of resistance. "Free Mandela" campaigns
      spread worldwide.

      By 1990, international pressure and protests within South Africa forced change. On February 11,
      1990, Mandela walked out of prison, holding hands with his wife Winnie. Millions watched on
      television.

      In 1994, South Africa held its first elections where all races could vote. Mandela was elected
      president. He focused on reconciliation - bringing people together rather than seeking revenge.
      He shared the 1993 Nobel Peace Prize with F.W. de Klerk.
    `,

    periodCostumes: {
      mandela: 'Simple clothes after prison, later colorful "Madiba shirts"',
      supporters: 'ANC colors - black, green, and gold/yellow, traditional African clothing',
      prison: 'Prison uniform - shorts and sandals on Robben Island'
    },

    keyLocations: ['Robben Island prison', 'Victor Verster Prison', 'Cape Town City Hall', 'Johannesburg'],

    storyAngles: [
      'A child seeing Mandela walk free on TV',
      'Waiting 27 years for freedom',
      'Forgiving instead of seeking revenge',
      'Voting for the first time'
    ],

    historicalDetails: {
      imprisonment: '27 years in prison',
      walk: 'Held Winnie\'s hand walking out of prison',
      election: 'First democratically elected President of South Africa',
      reconciliation: 'Created Truth and Reconciliation Commission'
    },

    ageAppropriate: true,
    themes: ['forgiveness', 'patience', 'equality', 'peaceful change', 'reconciliation']
  },

  // ============================================
  // CONSTRUCTION & ENGINEERING
  // ============================================

  'pyramids': {
    id: 'pyramids',
    name: 'Building the Great Pyramids',
    shortName: 'The Pyramids',
    year: -2560,
    date: 'Around 2560 BCE',
    location: 'Giza, Egypt',
    category: 'construction',

    keyFigures: [
      { name: 'Pharaoh Khufu (Cheops)', role: 'Pharaoh who ordered the Great Pyramid', nationality: 'Egyptian' },
      { name: 'Hemiunu', role: 'Vizier and architect of the Great Pyramid', nationality: 'Egyptian' }
    ],

    historicalContext: `
      The Great Pyramid of Giza was built about 4,500 years ago as a tomb for Pharaoh Khufu. It
      was the tallest structure in the world for nearly 4,000 years. The precision of its
      construction still amazes engineers today.

      About 2.3 million stone blocks, each weighing 2-80 tons, were cut, transported, and stacked
      with remarkable accuracy. The base is level to within 2 inches across 750 feet. The sides
      align almost perfectly with the compass directions.

      Contrary to myths, the pyramids were not built by slaves but by paid workers - farmers who
      worked during the Nile flood season when they couldn't farm. Archaeological evidence shows
      workers' villages with bakeries, breweries, and medical care.

      Ramps, levers, and careful organization allowed tens of thousands of workers to complete the
      Great Pyramid in about 20 years. It remains one of the Seven Wonders of the Ancient World
      and the only one still standing.
    `,

    periodCostumes: {
      pharaoh: 'Royal Egyptian attire - white kilt, gold jewelry, nemes headdress, false beard',
      workers: 'Simple linen kilts or loincloths, bare-chested, sandals or barefoot',
      priests: 'White linen robes, shaved heads, elaborate collars',
      scribes: 'White kilts, carrying papyrus and reed pens'
    },

    keyLocations: ['Giza plateau', 'Nile River', 'Stone quarries', 'Workers\' village'],

    storyAngles: [
      'A young worker helping build the pyramid',
      'An architect solving construction problems',
      'Life in the workers\' village',
      'The pharaoh inspecting progress'
    ],

    historicalDetails: {
      height: '481 feet (147 m) originally',
      blocks: '2.3 million blocks averaging 2.5 tons each',
      workers: 'About 20,000-30,000 workers',
      time: 'About 20 years to complete'
    },

    ageAppropriate: true,
    themes: ['teamwork', 'engineering', 'organization', 'ancient wisdom']
  },

  'eiffel-tower': {
    id: 'eiffel-tower',
    name: 'Building the Eiffel Tower',
    shortName: 'Eiffel Tower Opens',
    year: 1889,
    date: 'March 31, 1889',
    location: 'Paris, France',
    category: 'construction',

    keyFigures: [
      { name: 'Gustave Eiffel', role: 'Engineer and designer', nationality: 'French' }
    ],

    historicalContext: `
      The Eiffel Tower was built for the 1889 World's Fair, celebrating 100 years since the French
      Revolution. Many Parisians hated the design, calling it an "eyesore" and a "metal monster."
      Famous artists and writers signed a petition against it.

      Gustave Eiffel's company built the tower in just 2 years, 2 months, and 5 days using
      innovative techniques. The 18,038 iron pieces were manufactured precisely in a factory and
      assembled on site using 2.5 million rivets. Despite the height (1,063 feet/324 meters), only
      one worker died during construction - an unusually good safety record for the time.

      When completed, it was the tallest structure in the world. The tower was supposed to be
      temporary - dismantled after 20 years. But it proved useful for radio transmission and
      became beloved as the symbol of Paris.

      Today, nearly 7 million people visit each year. It has been repainted 19 times and has its
      own post office.
    `,

    periodCostumes: {
      eiffel: 'Late Victorian gentleman - top hat, frock coat, cane, full beard',
      workers: 'Late 19th century laborers - caps, vests, rolled sleeves, sturdy boots',
      parisians: 'Belle Époque fashion - bustles, parasols, bowler hats'
    },

    keyLocations: ['Champ de Mars, Paris', 'Construction site', 'Eiffel\'s factory'],

    storyAngles: [
      'A worker riveting beams high above Paris',
      'Critics who hated it, then loved it',
      'Opening day celebrations',
      'Proving the doubters wrong'
    ],

    historicalDetails: {
      height: '1,063 feet (324 m) with antenna',
      pieces: '18,038 iron pieces, 2.5 million rivets',
      time: '2 years, 2 months, 5 days to build',
      paint: 'Repainted every 7 years, requires 60 tons of paint'
    },

    ageAppropriate: true,
    themes: ['creativity', 'overcoming criticism', 'engineering', 'proving doubters wrong']
  },

  'panama-canal': {
    id: 'panama-canal',
    name: 'Panama Canal Opens',
    shortName: 'Panama Canal',
    year: 1914,
    date: 'August 15, 1914',
    location: 'Panama',
    category: 'construction',

    keyFigures: [
      { name: 'Theodore Roosevelt', role: 'US President who championed the project', nationality: 'American' },
      { name: 'George Washington Goethals', role: 'Chief Engineer who completed the canal', nationality: 'American' },
      { name: 'William Gorgas', role: 'Doctor who conquered yellow fever and malaria', nationality: 'American' }
    ],

    historicalContext: `
      Before the Panama Canal, ships traveling between the Atlantic and Pacific Oceans had to
      sail all the way around South America - adding 8,000 miles and weeks to the journey. A canal
      through the narrow Isthmus of Panama would change world trade forever.

      France tried first in the 1880s but failed. Disease (especially yellow fever and malaria)
      killed over 20,000 workers. The jungle, mountains, and the Chagres River seemed unconquerable.

      The United States took over in 1904. Dr. William Gorgas identified that mosquitoes spread
      disease and eliminated them through drainage and fumigation. The engineering solution was
      revolutionary: instead of digging a sea-level canal, they built a series of locks that lift
      ships 85 feet up to an artificial lake, then lower them down to the other ocean.

      About 75,000 workers, many from the Caribbean, dug out 240 million cubic yards of earth. The
      canal opened on August 15, 1914 - one of humanity's greatest engineering achievements.
    `,

    periodCostumes: {
      engineers: 'Early 20th century work attire - khaki suits, pith helmets for sun',
      workers: 'Work clothes, boots, hats for tropical sun',
      officials: 'White colonial suits, panama hats'
    },

    keyLocations: ['Culebra Cut', 'Gatun Locks', 'Gatun Lake', 'Panama City'],

    storyAngles: [
      'A worker helping dig the great ditch',
      'Dr. Gorgas fighting mosquitoes',
      'The first ship passing through',
      'Connecting two oceans'
    ],

    historicalDetails: {
      length: '50 miles (80 km)',
      locks: 'Three sets of locks lift ships 85 feet',
      excavation: '240 million cubic yards of earth removed',
      time: '10 years of American construction'
    },

    ageAppropriate: true,
    themes: ['engineering', 'problem-solving', 'perseverance', 'international cooperation']
  },

  'golden-gate': {
    id: 'golden-gate',
    name: 'Golden Gate Bridge Opens',
    shortName: 'Golden Gate Bridge',
    year: 1937,
    date: 'May 27, 1937',
    location: 'San Francisco, California, USA',
    category: 'construction',

    keyFigures: [
      { name: 'Joseph Strauss', role: 'Chief Engineer', nationality: 'American' },
      { name: 'Irving Morrow', role: 'Architect who designed the art deco style', nationality: 'American' },
      { name: 'Charles Ellis', role: 'Structural engineer who did the calculations', nationality: 'American' }
    ],

    historicalContext: `
      The Golden Gate strait connects San Francisco Bay to the Pacific Ocean. Many said a bridge
      across it was impossible - the water was too deep, the currents too strong, the winds too
      fierce, and earthquakes too common.

      Chief Engineer Joseph Strauss spent years convincing skeptics. When construction began in
      1933, during the Great Depression, it provided crucial jobs. Workers faced dangerous
      conditions: cold water, strong currents, and heights up to 746 feet.

      Strauss introduced a safety net under the bridge - revolutionary at the time. It saved 19
      men who fell, known as the "Halfway to Hell Club." Still, 11 workers died when a scaffold
      fell through the net.

      The iconic "International Orange" color was chosen by architect Irving Morrow - it blends
      with the natural landscape and is visible in fog. On opening day, 200,000 people walked
      across. The bridge is still considered one of the most beautiful in the world.
    `,

    periodCostumes: {
      engineers: '1930s business attire - suits, fedoras',
      workers: 'Depression-era work clothes - overalls, hard hats, work boots',
      public: '1930s American fashion - women in dresses with hats, men in suits'
    },

    keyLocations: ['Golden Gate strait', 'Bridge towers', 'San Francisco', 'Marin County'],

    storyAngles: [
      'Workers building high above the water',
      'The safety net that saved lives',
      'Opening day celebrations',
      'Building something "impossible"'
    ],

    historicalDetails: {
      length: '1.7 miles (2.7 km) total',
      height: 'Towers are 746 feet (227 m)',
      color: 'International Orange',
      opening: '200,000 people walked across on first day'
    },

    ageAppropriate: true,
    themes: ['overcoming obstacles', 'safety innovation', 'beauty in engineering', 'job creation']
  },

  'channel-tunnel': {
    id: 'channel-tunnel',
    name: 'Channel Tunnel Opens',
    shortName: 'The Chunnel',
    year: 1994,
    date: 'May 6, 1994',
    location: 'Under the English Channel (England to France)',
    category: 'construction',

    keyFigures: [
      { name: 'Queen Elizabeth II', role: 'British monarch at opening', nationality: 'British' },
      { name: 'President François Mitterrand', role: 'French President at opening', nationality: 'French' }
    ],

    historicalContext: `
      People had dreamed of connecting Britain to mainland Europe since Napoleon's time. The English
      Channel, just 21 miles at its narrowest, had always isolated Britain. In 1986, Britain and
      France finally agreed to build a tunnel.

      The project was enormous: 11 massive tunnel-boring machines worked from both sides, meeting
      in the middle under the sea. Workers dug through chalk and clay, 250 feet below the seabed.
      Three tunnels were built: two for trains and one service tunnel in between.

      On December 1, 1990, British and French workers broke through and shook hands under the
      Channel. Construction took 7 years and employed 15,000 workers. Ten workers died during
      construction.

      At 31.4 miles (50.5 km), it has the longest underwater section of any tunnel in the world.
      High-speed trains now travel between London and Paris in just over 2 hours, making Europe
      feel smaller and more connected.
    `,

    periodCostumes: {
      workers: '1990s construction gear - hard hats, overalls, reflective vests',
      royalty: 'Formal attire - Queen Elizabeth in coat dress and hat',
      engineers: 'Business suits with hard hats for site visits'
    },

    keyLocations: ['Folkestone, England', 'Coquelles, France', 'Inside the tunnel', 'Tunnel boring machine'],

    storyAngles: [
      'Workers meeting in the middle',
      'The moment of breakthrough',
      'First train journey under the sea',
      'Connecting countries that were once enemies'
    ],

    historicalDetails: {
      length: '31.4 miles (50.5 km), 23.5 miles underwater',
      depth: 'Up to 250 feet below seabed',
      time: '7 years of construction',
      handshake: 'British and French workers met December 1, 1990'
    },

    ageAppropriate: true,
    themes: ['international cooperation', 'engineering', 'connecting people', 'dreams realized']
  },

  // ============================================
  // CULTURAL & ARTS
  // ============================================

  'printing-press': {
    id: 'printing-press',
    name: 'Gutenberg\'s Printing Press',
    shortName: 'Printing Press',
    year: 1440,
    date: 'Around 1440',
    location: 'Mainz, Germany',
    category: 'culture',

    keyFigures: [
      { name: 'Johannes Gutenberg', role: 'Inventor of movable type printing', nationality: 'German' }
    ],

    historicalContext: `
      Before the printing press, every book had to be copied by hand - a process that could take
      months or years for a single book. Only the wealthy and religious institutions could afford
      books, and most people never saw one.

      Johannes Gutenberg, a goldsmith, developed movable type: individual metal letters that could
      be arranged to form pages, then rearranged for the next book. Combined with an adapted wine
      press and oil-based ink, this allowed books to be produced quickly and cheaply.

      The Gutenberg Bible, printed around 1455, was the first major book produced with movable
      type in Europe. About 180 copies were printed - a revolutionary number. Before Gutenberg,
      Europe had a few thousand handwritten books. Within 50 years, there were millions of printed
      books.

      The printing press spread knowledge, enabling the Renaissance, Reformation, and Scientific
      Revolution. It democratized learning and changed human history more than almost any other
      invention.
    `,

    periodCostumes: {
      gutenberg: 'Medieval German craftsman - long robe, leather apron, simple cap',
      workers: 'Medieval work clothes - tunics, leather aprons, cloth caps',
      scholars: 'Academic robes, simple caps'
    },

    keyLocations: ['Gutenberg\'s workshop in Mainz', 'Medieval town', 'Church or university library'],

    storyAngles: [
      'A child learning to read from the first books',
      'Gutenberg solving printing problems',
      'The excitement of seeing the first printed Bible',
      'Knowledge spreading across Europe'
    ],

    historicalDetails: {
      innovation: 'Movable metal type, oil-based ink, adapted wine press',
      bible: 'About 180 Gutenberg Bibles printed (~1455)',
      impact: 'Millions of books within 50 years',
      legacy: 'Enabled Renaissance, Reformation, Scientific Revolution'
    },

    ageAppropriate: true,
    themes: ['innovation', 'spreading knowledge', 'democratizing learning', 'changing the world']
  },

  'first-olympics': {
    id: 'first-olympics',
    name: 'First Modern Olympics',
    shortName: 'Modern Olympics',
    year: 1896,
    date: 'April 6-15, 1896',
    location: 'Athens, Greece',
    category: 'culture',

    keyFigures: [
      { name: 'Baron Pierre de Coubertin', role: 'Founder of the modern Olympics', nationality: 'French' },
      { name: 'Spyridon Louis', role: 'Greek winner of the first marathon', nationality: 'Greek' }
    ],

    historicalContext: `
      The ancient Olympic Games were held in Greece for over 1,000 years before being banned in
      393 AD. French aristocrat Pierre de Coubertin dreamed of reviving them to promote peace and
      understanding through sports.

      The first modern Olympics opened in Athens on April 6, 1896, with 241 athletes from 14
      countries competing in 43 events. Women were not allowed to compete. Many athletes paid
      their own way and were not professionals.

      The highlight was the marathon - a new event inspired by the ancient Greek legend of
      Pheidippides, who ran from Marathon to Athens. Greek water carrier Spyridon Louis won,
      becoming a national hero. The crowd went wild.

      The Olympics have grown from that small beginning to become the world's largest sporting
      event, with over 10,000 athletes from more than 200 countries. Women first competed in 1900
      and now make up nearly half of all athletes.
    `,

    periodCostumes: {
      athletes: '1890s sports attire - long shorts, sleeveless tops, leather shoes',
      officials: 'Late Victorian formal wear - top hats, frock coats',
      spectators: 'Greek traditional clothing and Western fashion mix'
    },

    keyLocations: ['Panathenaic Stadium, Athens', 'Marathon route', 'Olympic venues'],

    storyAngles: [
      'An athlete traveling to compete',
      'Spyridon Louis running the marathon',
      'The opening ceremony in ancient stadium',
      'Athletes from different countries meeting'
    ],

    historicalDetails: {
      athletes: '241 athletes from 14 countries',
      events: '43 events in 9 sports',
      marathon: 'First marathon race in Olympics',
      growth: 'From 241 athletes to over 10,000 today'
    },

    ageAppropriate: true,
    themes: ['international friendship', 'sportsmanship', 'peace', 'revival of traditions']
  },

  'disneyland-opening': {
    id: 'disneyland-opening',
    name: 'Disneyland Opens',
    shortName: 'Disneyland Opens',
    year: 1955,
    date: 'July 17, 1955',
    location: 'Anaheim, California, USA',
    category: 'culture',

    keyFigures: [
      { name: 'Walt Disney', role: 'Creator and visionary', nationality: 'American' }
    ],

    historicalContext: `
      Walt Disney, famous for Mickey Mouse and animated films, dreamed of a place where families
      could have fun together - unlike typical amusement parks of the time, which were often dirty
      and unsafe. He called his dream "Disneyland."

      Many people thought he was crazy. Banks refused to loan him money. He mortgaged his house
      and borrowed against his life insurance. He bought 160 acres of orange groves in Anaheim
      and began building his vision.

      Opening day, July 17, 1955, was chaotic - nicknamed "Black Sunday." Rides broke down, there
      wasn't enough drinking water, ladies' high heels sank into fresh asphalt, and counterfeit
      tickets caused overcrowding.

      But Walt's dream proved magical. Disneyland revolutionized themed entertainment with
      different "lands" (Adventureland, Tomorrowland, etc.) and attention to detail. Within its
      first year, 3.6 million people visited. Walt said, "Disneyland will never be completed as
      long as there is imagination left in the world."
    `,

    periodCostumes: {
      disney: '1950s business attire - suit, tie, sometimes shirtsleeves',
      castMembers: 'Theme-appropriate costumes matching each land',
      guests: '1950s American fashion - poodle skirts, saddle shoes, families in Sunday best'
    },

    keyLocations: ['Main Street USA', 'Sleeping Beauty Castle', 'Adventureland', 'Tomorrowland'],

    storyAngles: [
      'A family visiting on opening day',
      'Walt Disney showing his dream to others',
      'The first child to meet Mickey Mouse',
      'Making a dream come true'
    ],

    historicalDetails: {
      cost: '$17 million to build',
      opening: 'ABC broadcast live, 90 million watched',
      visitors: '3.6 million in first year',
      quote: '"Disneyland will never be completed as long as there is imagination left"'
    },

    ageAppropriate: true,
    themes: ['imagination', 'dreams', 'family', 'never giving up']
  },

  'first-movie': {
    id: 'first-movie',
    name: 'Birth of Cinema',
    shortName: 'First Movies',
    year: 1895,
    date: 'December 28, 1895',
    location: 'Paris, France',
    category: 'culture',

    keyFigures: [
      { name: 'Auguste Lumière', role: 'Co-inventor of cinema', nationality: 'French' },
      { name: 'Louis Lumière', role: 'Co-inventor of cinema', nationality: 'French' }
    ],

    historicalContext: `
      The Lumière brothers, Auguste and Louis, invented the Cinématographe - a device that could
      record, develop, and project moving pictures. On December 28, 1895, they held the first
      public movie screening at the Grand Café in Paris.

      33 people paid one franc each to see 10 short films, each less than a minute long. "Workers
      Leaving the Lumière Factory" showed exactly that. "Arrival of a Train" reportedly frightened
      viewers who thought the train would come out of the screen!

      The brothers thought cinema was just a curiosity with no future. "Cinema is an invention
      without any future," Louis reportedly said. How wrong he was!

      Within years, movie theaters spread worldwide. Georges Méliès created the first science
      fiction film, "A Trip to the Moon" (1902). By the 1920s, Hollywood became the movie capital
      of the world. Today, cinema is a global industry reaching billions of people.
    `,

    periodCostumes: {
      brothers: 'Late Victorian professional attire - suits, cravats',
      audience: '1890s Parisian fashion - long dresses, top hats, elegant evening wear',
      workers: 'Factory workers in work clothes (in the films)'
    },

    keyLocations: ['Grand Café, Paris', 'Lumière factory, Lyon', 'Early movie theaters'],

    storyAngles: [
      'Seeing moving pictures for the first time',
      'The audience\'s reaction to the train',
      'The brothers inventing their machine',
      'A new way of telling stories'
    ],

    historicalDetails: {
      screening: 'December 28, 1895, Grand Café, Paris',
      audience: '33 people at first public screening',
      cost: 'One franc admission',
      quote: '"Cinema is an invention without any future" - Louis Lumière'
    },

    ageAppropriate: true,
    themes: ['invention', 'storytelling', 'entertainment', 'unexpected success']
  },

  // ============================================
  // NATURAL WORLD & ARCHAEOLOGY
  // ============================================

  'king-tut': {
    id: 'king-tut',
    name: 'Discovery of King Tut\'s Tomb',
    shortName: 'King Tut\'s Tomb',
    year: 1922,
    date: 'November 4, 1922',
    location: 'Valley of the Kings, Egypt',
    category: 'archaeology',

    keyFigures: [
      { name: 'Howard Carter', role: 'British archaeologist', nationality: 'British' },
      { name: 'Lord Carnarvon', role: 'Patron who funded the excavation', nationality: 'British' },
      { name: 'Tutankhamun', role: 'Egyptian pharaoh (c. 1341-1323 BCE)', nationality: 'Egyptian' }
    ],

    historicalContext: `
      Howard Carter had spent years searching the Valley of the Kings for undiscovered tombs.
      Most experts thought everything had been found. His patron, Lord Carnarvon, was ready to
      give up after years of fruitless digging.

      On November 4, 1922, a worker discovered a step cut into the rock. Carter's team carefully
      excavated stairs leading down to a sealed doorway. Carter made a small hole and peered in
      with a candle. "Can you see anything?" Carnarvon asked. "Yes, wonderful things," Carter
      replied.

      The tomb of Tutankhamun was almost intact - rare because most tombs had been robbed in
      antiquity. Inside were over 5,000 objects: gold, jewelry, chariots, furniture, food, and
      the famous golden death mask weighing 24 pounds.

      The discovery sparked worldwide interest in ancient Egypt. Tutankhamun, a minor pharaoh who
      died around age 19, became the most famous Egyptian king in history.
    `,

    periodCostumes: {
      carter: '1920s expedition attire - khaki suit, pith helmet, bow tie',
      workers: 'Egyptian workers in simple galabiyyas and turbans',
      carnarvon: 'British aristocrat attire - three-piece suit, hat'
    },

    keyLocations: ['Valley of the Kings', 'Tomb entrance', 'Inside the burial chambers'],

    storyAngles: [
      'The moment of discovery',
      'Peering into the tomb for the first time',
      'Uncovering the golden treasures',
      'Learning about a pharaoh who died young'
    ],

    historicalDetails: {
      tutAge: 'Tutankhamun died around age 19',
      objects: 'Over 5,000 artifacts in the tomb',
      mask: 'Gold death mask weighs 24 pounds (11 kg)',
      excavation: 'Took 10 years to fully excavate'
    },

    ageAppropriate: true,
    themes: ['discovery', 'patience', 'ancient history', 'perseverance']
  },

  'first-zoo': {
    id: 'first-zoo',
    name: 'First Modern Zoo Opens',
    shortName: 'London Zoo Opens',
    year: 1828,
    date: 'April 27, 1828',
    location: 'London, England',
    category: 'culture',

    keyFigures: [
      { name: 'Stamford Raffles', role: 'Founder of the Zoological Society of London', nationality: 'British' }
    ],

    historicalContext: `
      Before modern zoos, only royalty and the wealthy could see exotic animals in private
      menageries. Sir Stamford Raffles, a colonial administrator and naturalist, founded the
      Zoological Society of London in 1826 to study animals scientifically.

      The London Zoo opened in Regent's Park on April 27, 1828 - initially only for scientists.
      It opened to the public in 1847. The zoo introduced many animals to Britain for the first
      time, including hippos, quaggas (now extinct), and the first chimpanzee.

      The word "zoo" itself comes from shortening "zoological gardens." London Zoo pioneered
      animal care, the first reptile house (1849), first public aquarium (1853), and first
      insect house (1881).

      Modern zoos have evolved to focus on conservation, breeding endangered species, and
      education rather than just display. London Zoo now participates in over 130 conservation
      projects worldwide.
    `,

    periodCostumes: {
      visitors: 'Georgian/early Victorian - top hats, tailcoats, long dresses, bonnets',
      zookeepers: 'Simple work clothes with aprons',
      scientists: 'Academic dress, carrying notebooks'
    },

    keyLocations: ['Regent\'s Park, London', 'Various animal enclosures', 'Reptile house'],

    storyAngles: [
      'A child seeing a giraffe for the first time',
      'Scientists studying new animals',
      'Caring for animals from faraway lands',
      'Learning about wildlife'
    ],

    historicalDetails: {
      opening: 'Initially only for scientific study, public 1847',
      word: '"Zoo" shortened from "zoological gardens"',
      firsts: 'First reptile house, public aquarium, insect house',
      conservation: 'Now focuses on saving endangered species'
    },

    ageAppropriate: true,
    themes: ['learning about nature', 'conservation', 'wonder', 'science']
  },

  'pompeii-discovery': {
    id: 'pompeii-discovery',
    name: 'Rediscovery of Pompeii',
    shortName: 'Finding Pompeii',
    year: 1748,
    date: '1748 (systematic excavations)',
    location: 'Near Naples, Italy',
    category: 'archaeology',

    keyFigures: [
      { name: 'King Charles III of Spain', role: 'Ordered excavations as King of Naples', nationality: 'Spanish' },
      { name: 'Karl Weber', role: 'Swiss engineer who led early excavations', nationality: 'Swiss' }
    ],

    historicalContext: `
      In 79 AD, Mount Vesuvius erupted, burying the Roman cities of Pompeii and Herculaneum under
      volcanic ash and pumice. About 2,000 people died in Pompeii. The cities were forgotten for
      nearly 1,700 years.

      In 1748, Spanish King Charles III (then ruling Naples) ordered systematic excavations of
      Pompeii. Workers discovered an entire city frozen in time: houses, shops, theaters, baths,
      and even food left on tables. Plaster casts of victims show their final moments.

      Pompeii revealed everyday Roman life in extraordinary detail. Graffiti on walls, frescos
      showing daily activities, fast-food shops, and children's toys helped historians understand
      ancient Rome better than any other discovery.

      Today, about 3 million tourists visit annually. About a third of Pompeii is still buried,
      with archaeologists continuing to make discoveries.
    `,

    periodCostumes: {
      romans: 'Togas for citizens, tunics for workers, sandals',
      excavators: '18th century work clothes - breeches, waistcoats, simple caps',
      nobles: '18th century aristocratic dress - wigs, embroidered coats'
    },

    keyLocations: ['Streets of Pompeii', 'Forum', 'Homes with frescos', 'Mount Vesuvius'],

    storyAngles: [
      'A Roman child\'s life before the eruption',
      'Discovering a city lost for centuries',
      'Finding clues about daily Roman life',
      'What everyday objects tell us about history'
    ],

    historicalDetails: {
      eruption: 'August 24, 79 AD',
      buried: 'Under 13-20 feet of volcanic ash',
      rediscovery: 'Systematic excavation began 1748',
      detail: 'Preserved food, graffiti, toys, frescos'
    },

    ageAppropriate: true,
    themes: ['discovery', 'history', 'understanding the past', 'archaeology']
  },

  'natural-history-museum': {
    id: 'natural-history-museum',
    name: 'First Natural History Museum',
    shortName: 'Natural History Museum',
    year: 1881,
    date: 'April 18, 1881',
    location: 'London, England',
    category: 'culture',

    keyFigures: [
      { name: 'Richard Owen', role: 'Naturalist who championed the museum', nationality: 'British' },
      { name: 'Alfred Waterhouse', role: 'Architect who designed the building', nationality: 'British' }
    ],

    historicalContext: `
      Richard Owen, the scientist who coined the term "dinosaur," believed natural history
      collections deserved their own grand building, separate from the British Museum. He
      championed the creation of a dedicated Natural History Museum for decades.

      The museum opened in 1881 in a stunning cathedral-like building in South Kensington.
      Architect Alfred Waterhouse decorated it with terracotta sculptures of animals and plants.
      Living species are on the west side; extinct species on the east.

      The museum houses over 80 million specimens, including Darwin's collection from the Beagle
      voyage. "Dippy" the Diplodocus cast became the beloved central attraction for over 100 years
      before being replaced by a blue whale skeleton named "Hope."

      The museum remains one of the world's great institutions for understanding life on Earth,
      conducting research and inspiring millions of visitors each year.
    `,

    periodCostumes: {
      victorians: 'Late Victorian fashion - bustles, top hats, formal attire',
      scientists: 'Victorian academic dress, often with beard',
      children: 'Victorian children\'s clothing - sailor suits, pinafores'
    },

    keyLocations: ['Main hall', 'Dinosaur gallery', 'Darwin Centre', 'Gardens'],

    storyAngles: [
      'A child visiting the museum for the first time',
      'Scientists preparing specimens',
      'Discovering dinosaurs through fossils',
      'A building designed like a cathedral to nature'
    ],

    historicalDetails: {
      specimens: 'Over 80 million specimens',
      building: 'Terracotta decorated with plants and animals',
      dippy: 'Diplodocus cast was central icon for over 100 years',
      darwin: 'Houses specimens from Darwin\'s Beagle voyage'
    },

    ageAppropriate: true,
    themes: ['learning', 'nature', 'science', 'wonder']
  },

  'galapagos-darwin': {
    id: 'galapagos-darwin',
    name: 'Darwin Visits the Galápagos',
    shortName: 'Darwin\'s Voyage',
    year: 1835,
    date: 'September-October 1835',
    location: 'Galápagos Islands, Ecuador',
    category: 'science',

    keyFigures: [
      { name: 'Charles Darwin', role: 'Naturalist and scientist', nationality: 'British' }
    ],

    historicalContext: `
      In 1831, 22-year-old Charles Darwin joined HMS Beagle as the ship's naturalist for a voyage
      around the world. In September 1835, the ship arrived at the Galápagos Islands, a volcanic
      archipelago 600 miles off the coast of Ecuador.

      Darwin spent five weeks on the islands, collecting specimens and taking notes. He observed
      that different islands had different species of finches, tortoises, and mockingbirds. The
      giant tortoises' shells varied by island - locals could tell which island a tortoise came
      from just by looking at its shell.

      These observations puzzled Darwin. Why would God create slightly different species for each
      nearby island? Over the next 20 years, Darwin developed his theory of evolution by natural
      selection, explaining how species change over time to adapt to their environments.

      His 1859 book "On the Origin of Species" revolutionized biology and our understanding of
      life on Earth.
    `,

    periodCostumes: {
      darwin: '1830s gentleman-naturalist - coat, waistcoat, cravat, collecting bag',
      sailors: 'Royal Navy sailors in period uniform',
      locals: 'Ecuadorian coastal clothing'
    },

    keyLocations: ['HMS Beagle', 'Galápagos Islands', 'Volcanic landscapes', 'Darwin\'s study (later)'],

    storyAngles: [
      'Young Darwin exploring the islands',
      'Observing unusual animals',
      'Noticing differences between islands',
      'Asking "why?" and seeking answers'
    ],

    historicalDetails: {
      voyage: 'HMS Beagle, 1831-1836',
      duration: 'Five weeks in Galápagos',
      specimens: 'Collected hundreds of specimens',
      theory: 'Developed theory over 20+ years'
    },

    ageAppropriate: true,
    themes: ['observation', 'curiosity', 'questioning', 'scientific thinking']
  },

  'terracotta-army': {
    id: 'terracotta-army',
    name: 'Discovery of the Terracotta Army',
    shortName: 'Terracotta Army',
    year: 1974,
    date: 'March 1974',
    location: 'Xi\'an, China',
    category: 'archaeology',

    keyFigures: [
      { name: 'Yang Zhifa', role: 'Farmer who made the discovery', nationality: 'Chinese' },
      { name: 'Emperor Qin Shi Huang', role: 'First Emperor of China, built the army', nationality: 'Chinese' }
    ],

    historicalContext: `
      In March 1974, farmers digging a well near Xi'an, China, struck something hard. They had
      discovered one of archaeology's greatest treasures: the Terracotta Army, buried for over
      2,200 years.

      Emperor Qin Shi Huang, who unified China and began building the Great Wall, wanted an army
      to protect him in the afterlife. Craftsmen created over 8,000 life-sized clay soldiers,
      each with unique facial features, along with horses, chariots, and weapons.

      The soldiers were originally painted in bright colors, but most paint has faded. They were
      arranged in battle formation in underground pits. The emperor's actual tomb, nearby under
      a hill, has not been excavated - ancient texts describe rivers of mercury inside.

      Today, three pits are open to visitors. Archaeologists are still finding new warriors and
      working to preserve the remaining paint. It's considered the "Eighth Wonder of the World."
    `,

    periodCostumes: {
      terracottaSoldiers: 'Qin Dynasty military armor - detailed sculpted armor, topknots, varying poses',
      emperor: 'Imperial robes, jade ornaments, elaborate headdress',
      modernFarmers: '1970s Chinese rural clothing'
    },

    keyLocations: ['Farmer\'s well site', 'Pit 1 (largest)', 'Emperor\'s tomb mound'],

    storyAngles: [
      'A farmer discovering ancient soldiers',
      'Imagining the emperor planning his eternal army',
      'Craftsmen creating unique faces',
      'Secrets still buried underground'
    ],

    historicalDetails: {
      soldiers: 'Over 8,000 warriors, 670 horses, 130 chariots',
      unique: 'Each soldier has unique facial features',
      age: 'Buried around 210 BCE',
      paint: 'Originally painted in bright colors'
    },

    ageAppropriate: true,
    themes: ['discovery', 'ancient history', 'craftsmanship', 'mystery']
  },

  'hubble-launch': {
    id: 'hubble-launch',
    name: 'Hubble Space Telescope Launch',
    shortName: 'Hubble Telescope',
    year: 1990,
    date: 'April 24, 1990',
    location: 'Earth orbit',
    category: 'science',

    keyFigures: [
      { name: 'Lyman Spitzer', role: 'Astronomer who first proposed a space telescope (1946)', nationality: 'American' },
      { name: 'Story Musgrave', role: 'Astronaut who led the repair mission', nationality: 'American' }
    ],

    historicalContext: `
      Earth's atmosphere blurs the view of stars and galaxies. Astronomer Lyman Spitzer proposed
      in 1946 putting a telescope in space, above the atmosphere. Decades later, the Hubble Space
      Telescope was built.

      Launched in 1990, Hubble seemed like a disaster. Its main mirror was flawed, producing blurry
      images. NASA became a laughingstock. But in 1993, astronauts performed a daring repair mission,
      installing corrective optics - like giving Hubble glasses.

      The repair worked spectacularly. Hubble has since made over 1.5 million observations, showing
      us galaxies billions of light-years away, the birth of stars, and helped determine the age of
      the universe (13.8 billion years). Its images of deep space, showing thousands of galaxies in
      a tiny patch of sky, changed our understanding of the cosmos.

      Hubble continues operating today, joined by the newer James Webb Space Telescope.
    `,

    periodCostumes: {
      astronauts: 'NASA spacesuits and flight suits',
      scientists: 'Lab coats and 1990s casual professional attire',
      missionControl: 'Business casual with headsets'
    },

    keyLocations: ['Space Shuttle', 'Earth orbit', 'Mission Control', 'Deep space (images)'],

    storyAngles: [
      'The disappointment of the blurry images',
      'Astronauts fixing Hubble in space',
      'Seeing distant galaxies for the first time',
      'Looking back in time through light'
    ],

    historicalDetails: {
      orbit: '340 miles above Earth',
      mirror: '7.9 feet (2.4 m) diameter',
      repair: '1993 mission fixed the mirror flaw',
      observations: 'Over 1.5 million observations'
    },

    ageAppropriate: true,
    themes: ['problem-solving', 'perseverance', 'wonder', 'discovery']
  },

  'internet-creation': {
    id: 'internet-creation',
    name: 'The World Wide Web is Born',
    shortName: 'Birth of the Web',
    year: 1991,
    date: 'August 6, 1991',
    location: 'CERN, Geneva, Switzerland',
    category: 'invention',

    keyFigures: [
      { name: 'Tim Berners-Lee', role: 'Inventor of the World Wide Web', nationality: 'British' }
    ],

    historicalContext: `
      In 1989, Tim Berners-Lee, a British scientist at CERN (the European physics laboratory),
      had a problem: researchers worldwide needed to share information, but computers used
      different systems that couldn't talk to each other.

      He invented three key technologies: HTML (the language of web pages), URLs (web addresses),
      and HTTP (how computers communicate). Together, these created the World Wide Web - a way
      to link documents across any computer in the world.

      On August 6, 1991, the first website went live at CERN, explaining what the World Wide Web
      was. Berners-Lee made his invention free for everyone to use - he could have become a
      billionaire if he had patented it.

      The web transformed human communication, commerce, and culture. By 2023, there were nearly
      2 billion websites. Berners-Lee was knighted and continues to advocate for an open,
      accessible web for everyone.
    `,

    periodCostumes: {
      scientists: 'Early 1990s casual professional - sweaters, button-down shirts',
      computerUsers: '1990s office attire'
    },

    keyLocations: ['CERN offices', 'Computer terminal', 'Server room'],

    storyAngles: [
      'Wanting to share information easily',
      'Creating something free for everyone',
      'The first website going live',
      'Connecting the whole world'
    ],

    historicalDetails: {
      firstSite: 'info.cern.ch, launched August 6, 1991',
      decision: 'Made the technology free for everyone',
      knight: 'Knighted in 2004',
      websites: 'Nearly 2 billion websites by 2023'
    },

    ageAppropriate: true,
    themes: ['sharing', 'generosity', 'connection', 'changing the world']
  },

  'human-genome': {
    id: 'human-genome',
    name: 'Human Genome Decoded',
    shortName: 'Human Genome Project',
    year: 2003,
    date: 'April 14, 2003',
    location: 'International collaboration',
    category: 'science',

    keyFigures: [
      { name: 'Francis Collins', role: 'Director of Human Genome Project', nationality: 'American' },
      { name: 'Craig Venter', role: 'Led private sequencing effort', nationality: 'American' }
    ],

    historicalContext: `
      DNA contains the instructions for building a human being - about 3 billion "letters" of
      genetic code. In 1990, scientists from 20 countries began the Human Genome Project to read
      this entire instruction book.

      It was like reading a book with 3 billion letters but no spaces or punctuation. The project
      used supercomputers and new technologies. A race developed between the government project
      and a private company led by Craig Venter.

      In 2000, both groups announced draft sequences. On April 14, 2003, the complete human genome
      was declared finished - taking 13 years and about $3 billion. Today, the same sequencing
      can be done in a day for under $1,000.

      The project helps scientists understand genetic diseases, develop new medicines, and trace
      human ancestry. It was compared to putting a man on the Moon - one of humanity's greatest
      scientific achievements.
    `,

    periodCostumes: {
      scientists: 'Lab coats, safety glasses, late 1990s/early 2000s attire',
      computerScientists: 'Casual tech industry clothing'
    },

    keyLocations: ['Laboratories', 'Computer centers', 'Universities worldwide'],

    storyAngles: [
      'Reading the book of life',
      'Scientists from many countries working together',
      'Understanding what makes us human',
      'Helping cure diseases'
    ],

    historicalDetails: {
      letters: '3 billion base pairs',
      duration: '13 years (1990-2003)',
      cost: 'About $3 billion originally, now under $1,000',
      countries: '20 countries participated'
    },

    ageAppropriate: true,
    themes: ['cooperation', 'discovery', 'understanding ourselves', 'helping others']
  },

  'first-heart-transplant': {
    id: 'first-heart-transplant',
    name: 'First Heart Transplant',
    shortName: 'Heart Transplant',
    year: 1967,
    date: 'December 3, 1967',
    location: 'Cape Town, South Africa',
    category: 'science',

    keyFigures: [
      { name: 'Christiaan Barnard', role: 'Surgeon who performed the transplant', nationality: 'South African' },
      { name: 'Louis Washkansky', role: 'Patient who received the heart', nationality: 'South African' },
      { name: 'Denise Darvall', role: 'Donor, died in car accident', nationality: 'South African' }
    ],

    historicalContext: `
      Louis Washkansky was dying from heart disease. There was no treatment. Dr. Christiaan
      Barnard, a surgeon at Groote Schuur Hospital in Cape Town, South Africa, had spent years
      preparing for what many thought impossible: replacing a human heart.

      On December 3, 1967, Denise Darvall, a young woman, was fatally injured in a car accident.
      Her father gave permission for her heart to be used. In a 9-hour operation, Barnard's team
      of 30 replaced Washkansky's damaged heart with the healthy one.

      The world held its breath. Washkansky survived the surgery and lived for 18 days before
      dying of pneumonia - his weakened immune system couldn't fight infection. Despite the short
      survival, the operation proved heart transplants were possible.

      Today, about 3,500 heart transplants are performed yearly in the US alone. Patients can
      live decades with transplanted hearts, thanks to better anti-rejection drugs.
    `,

    periodCostumes: {
      surgeons: '1960s surgical scrubs, masks, caps',
      nurses: '1960s white nursing uniforms',
      patient: 'Hospital gown'
    },

    keyLocations: ['Groote Schuur Hospital', 'Operating theater', 'Hospital room'],

    storyAngles: [
      'A doctor daring to try the impossible',
      'The gift of a donor family',
      'The hope of a dying patient',
      'Saving lives through medicine'
    ],

    historicalDetails: {
      duration: '9-hour surgery',
      team: '30 medical staff',
      survival: 'Washkansky lived 18 days',
      today: 'About 3,500 heart transplants per year in US'
    },

    ageAppropriate: true,
    themes: ['courage', 'medical innovation', 'gift of life', 'hope']
  },
};

// Get all events as an array
function getAllEvents() {
  return Object.values(HISTORICAL_EVENTS);
}

// Get events by category
function getEventsByCategory(category) {
  return getAllEvents().filter(event => event.category === category);
}

// Get event by ID
function getEventById(id) {
  return HISTORICAL_EVENTS[id] || null;
}

// Get random events
function getRandomEvents(count = 5) {
  const all = getAllEvents();
  const shuffled = all.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

// Get events suitable for story generation (formatted for prompt)
function getEventForStory(eventId) {
  const event = getEventById(eventId);
  if (!event) return null;

  return {
    id: event.id,
    name: event.name,
    year: event.year,
    date: event.date,
    location: event.location,
    keyFigures: event.keyFigures,
    historicalContext: event.historicalContext.trim(),
    costumes: event.periodCostumes,
    locations: event.keyLocations,
    storyAngles: event.storyAngles,
    details: event.historicalDetails,
    themes: event.themes
  };
}

// Categories for UI
const EVENT_CATEGORIES = [
  { id: 'exploration', name: 'Exploration & Discovery', icon: '🧭' },
  { id: 'science', name: 'Science & Medicine', icon: '🔬' },
  { id: 'invention', name: 'Inventions', icon: '💡' },
  { id: 'rights', name: 'Human Rights & Freedom', icon: '✊' },
  { id: 'construction', name: 'Great Constructions', icon: '🏗️' },
  { id: 'culture', name: 'Culture & Arts', icon: '🎭' },
  { id: 'archaeology', name: 'Archaeological Discoveries', icon: '🏺' }
];

module.exports = {
  HISTORICAL_EVENTS,
  EVENT_CATEGORIES,
  getAllEvents,
  getEventsByCategory,
  getEventById,
  getRandomEvents,
  getEventForStory
};
