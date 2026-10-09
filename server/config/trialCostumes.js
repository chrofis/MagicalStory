// server/config/trialCostumes.js
// Pre-defined costumes per story topic for trial stories
// Each entry: { male: "description", female: "description" }
// NO face coverings (helmets, masks, face-covering hats) — faces must stay visible

const TRIAL_COSTUMES = {
  // ══════════════════════════════════════════════════════════════
  // ADVENTURE THEMES
  // ══════════════════════════════════════════════════════════════
  adventure: {
    pirate: {
      male: "Red and white horizontal-striped sailor shirt, brown leather vest over it, dark brown canvas trousers tucked into tall black boots, wide black leather belt with brass buckle, no hat, bare head",
      female: "Red and white horizontal-striped sailor blouse, brown leather corset vest over it, dark blue flowing skirt over dark trousers, tall black boots, wide black leather belt, no hat, bare head"
    },
    knight: {
      male: "Silver chain mail tunic over a grey padded gambeson, brown leather bracers, dark brown leather boots, plain brown sword belt, no helmet, bare head",
      female: "Silver chain mail tunic over a grey padded gambeson, brown leather bracers, dark brown leather boots, plain brown sword belt, no helmet, bare head"
    },
    cowboy: {
      male: "Blue denim jeans, red and black plaid flannel shirt, brown leather vest, brown cowboy boots with silver spurs, red bandana around neck, brown felt cowboy hat with a wide flat brim",
      female: "Blue denim jeans, red and black plaid flannel shirt, brown leather vest, brown cowboy boots, red bandana around neck, brown felt cowboy hat with a wide flat brim"
    },
    ninja: {
      male: "Dark blue traditional ninja outfit (shinobi shozoku), black cloth wraps on forearms, black soft tabi boots, no hood, no mask, bare head",
      female: "Dark blue traditional ninja outfit (shinobi shozoku), black cloth wraps on forearms, black soft tabi boots, no hood, no mask, bare head"
    },
    viking: {
      male: "Brown fur-trimmed tunic, brown leather bracers, thick brown leather belt with round bronze buckle, fur-lined brown boots, grey woolen cloak, no helmet, bare head",
      female: "Long dark red woolen dress with gold embroidered trim, brown leather belt with pouch, grey fur-lined cloak, brown leather boots, no helmet, bare head"
    },
    roman: {
      male: "White tunic (tunica) with red trim, brown leather sandals (caligae), brown leather wrist guards, simple brown belt",
      female: "White stola dress with gold trim, brown leather sandals, brown belt with gold clasp"
    },
    egyptian: {
      male: "White linen kilt (shendyt), gold collar necklace, tan leather sandals, gold arm bands",
      female: "White linen dress with gold belt, blue and gold beaded collar necklace, tan leather sandals, gold arm bands"
    },
    greek: {
      male: "White chiton tunic with blue border, brown leather sandals, brown rope belt, silver shoulder clasp",
      female: "White flowing peplos dress with gold trim, brown leather sandals, gold waist belt"
    },
    caveman: {
      male: "Brown animal fur tunic, brown leather cord belt, bare feet, white bone necklace",
      female: "Tan animal fur dress, brown leather cord belt, bare feet, white shell necklace"
    },
    samurai: {
      male: "Dark grey hakama pants, navy kimono top with white family crest, red obi sash belt, brown wooden sandals (geta), no helmet, bare head",
      female: "Dark grey hakama pants, pale pink kimono top with floral pattern, red obi sash belt, brown wooden sandals (geta), no helmet, bare head"
    },
    wizard: {
      male: "Long flowing robe in deep blue with silver star patterns, brown leather belt with pouch, pointed grey cloth shoes, tall pointed deep blue wizard hat with a wide brim and a silver band",
      female: "Long flowing robe in deep purple with golden moon patterns, brown leather belt with pouch, pointed grey cloth shoes, tall pointed deep purple wizard hat with a wide brim and a golden band"
    },
    dragon: {
      male: "Brown leather armor vest with scale pattern, dark brown sturdy boots, brown arm guards, brown adventurer's belt with pouches",
      female: "Brown leather armor vest with scale pattern, dark brown sturdy boots, brown arm guards, brown adventurer's belt with pouches"
    },
    superhero: {
      male: "Bright red bodysuit with blue cape, blue boots, yellow utility belt, yellow emblem on chest",
      female: "Bright red bodysuit with blue cape, blue boots, yellow utility belt, yellow emblem on chest"
    },
    detective: {
      male: "Brown tweed jacket, white shirt, dark brown trousers, black polished shoes, brass magnifying glass on a chain, no hat, bare head",
      female: "Brown tweed blazer, white blouse, green plaid skirt, black polished shoes, brass magnifying glass on a chain, no hat, bare head"
    },
    princess: {
      male: "Royal blue velvet doublet with gold embroidery, white silk shirt, dark blue trousers, polished boots, thin gold circlet crown",
      female: "Flowing pink and gold ball gown with puffy sleeves, satin gloves, sparkling tiara, delicate glass slippers"
    },
    unicorn: {
      male: "Shimmering white tunic with rainbow trim, silver boots, crystal pendant, lilac star-dusted cape",
      female: "Shimmering white dress with rainbow ribbons, silver shoes, crystal tiara, lilac star-dusted cape"
    },
    mermaid: {
      male: "Long-sleeve scale-pattern swim shirt in sea green over the whole torso, one merman tail replacing the legs from the waist down, no feet, white shell necklace, orange coral arm band",
      female: "Long-sleeve scale-pattern swim shirt in sea green over the whole torso, one mermaid tail replacing the legs from the waist down, no feet, white shell necklace, pink coral tiara"
    },
    dinosaur: {
      male: "Khaki explorer shorts, olive safari vest with many pockets, brown hiking boots, brown adventurer's belt",
      female: "Khaki explorer shorts, olive safari vest with many pockets, brown hiking boots, brown adventurer's belt"
    },
    space: {
      male: "Silver-white space suit with blue patches, utility belt, space boots, mission patch on shoulder",
      female: "Silver-white space suit with blue patches, utility belt, space boots, mission patch on shoulder"
    },
    ocean: {
      male: "Wetsuit in blue and black, diving flippers, waterproof utility belt",
      female: "Wetsuit in blue and black, diving flippers, waterproof utility belt"
    },
    jungle: {
      male: "Khaki shorts, green explorer shirt with rolled sleeves, brown hiking boots, tan canvas backpack",
      female: "Khaki shorts, green explorer shirt with rolled sleeves, brown hiking boots, tan canvas backpack"
    },
    farm: {
      male: "Blue denim overalls over red and white plaid shirt, green rubber boots, straw in pocket",
      female: "Blue denim overalls over red and white plaid shirt, green rubber boots, brown gardening gloves tucked in pocket"
    },
    forest: {
      male: "Green tunic, brown leather boots, dark green hooded cloak, brown leather belt with pouch",
      female: "Green tunic dress, brown leather boots, dark green hooded cloak, brown leather belt with pouch"
    },
    fireman: {
      male: "Yellow firefighter turnout coat with silver reflective stripes, dark navy trousers, black rubber boots",
      female: "Yellow firefighter turnout coat with silver reflective stripes, dark navy trousers, black rubber boots"
    },
    doctor: {
      male: "White lab coat over light blue scrubs, white comfortable shoes, grey stethoscope around neck",
      female: "White lab coat over light blue scrubs, white comfortable shoes, grey stethoscope around neck"
    },
    police: {
      male: "Dark blue police uniform shirt with badge, dark trousers, black shoes, utility belt",
      female: "Dark blue police uniform shirt with badge, dark trousers, black shoes, utility belt"
    },
    christmas: {
      male: "Red velvet suit with white fur trim, black boots, wide black belt with gold buckle",
      female: "Red velvet dress with white fur trim, black boots, candy cane striped stockings"
    },
    newyear: {
      male: "Sparkly formal suit in midnight blue, silver bow tie, black shiny shoes, gold party hat",
      female: "Sparkly formal dress in midnight blue, silver shiny shoes, gold glittery tiara"
    },
    easter: {
      male: "Pastel yellow vest over white shirt, beige trousers, light blue bow tie, wicker basket",
      female: "Pastel pink dress with white flower pattern, white shoes, flower crown of white and yellow flowers"
    },
    halloween: {
      male: "Black cape over black clothes, grey spiderweb-patterned vest, black boots",
      female: "Black cape over black dress, grey spiderweb-patterned bodice, black boots"
    }
  },

  // ══════════════════════════════════════════════════════════════
  // HISTORICAL EVENTS
  // Period costumes extracted from prompts/historical-guides.txt
  // ══════════════════════════════════════════════════════════════
  historical: {
    // Every garment names its colour (as the adventure block does) so the head
    // row and the body row of an avatar sheet, and every page, agree on the
    // outfit. Colours are plausible for the era: undyed or vegetable-dyed
    // wool and linen for the medieval and early modern entries, and so on.
    // Swiss History
    'swiss-founding': {
      male: "Undyed beige woolen tunic, dark brown leather belt, grey fur-lined cloak, brown leather boots, dark grey woolen leggings",
      female: "Long dark green woolen dress with a cream linen apron, brown leather belt, grey woolen shawl, brown leather shoes"
    },
    'wilhelm-tell': {
      male: "Moss green farmer's tunic, tan leather breeches, brown sturdy boots, grey woolen cloak, dark brown leather belt",
      female: "Long dark red woolen dress with a green embroidered bodice, white linen apron, brown leather shoes"
    },
    'battle-morgarten': {
      male: "Off-white padded linen gambeson, brown leather bracers, grey simple chain mail vest, dark brown leather boots, dark green woolen cloak",
      female: "Long brown woolen dress with a cream linen apron, dark brown leather belt, grey woolen shawl"
    },
    'battle-sempach': {
      male: "Off-white padded gambeson, brown leather bracers, grey chain mail vest, dark brown leather boots, red cloth surcoat with a white Swiss cross",
      female: "Long blue woolen dress with cream embroidered trim, brown leather belt, white linen head covering"
    },
    'swiss-reformation': {
      male: "Black scholar's robe, white collar, black leather shoes, brown leather belt with a brown book pouch",
      female: "Plain black dress with a white collar and white cuffs, white linen cap, black leather shoes"
    },
    'red-cross-founding': {
      male: "Black formal suit with a white shirt, white cravat, black leather shoes, black top hat (carried)",
      female: "Dark grey dress with a white collar, white nurse's apron with a red cross, black leather shoes"
    },
    'general-dufour': {
      male: "Swiss military uniform in a dark blue jacket with gold brass buttons, white trousers, black leather boots",
      female: "Simple navy blue dress with a white apron, cream bonnet, brown leather shoes"
    },
    'sonderbund-war': {
      male: "Swiss military coat in dark blue with gold brass buttons, grey trousers, black leather boots, dark blue peaked cap (carried)",
      female: "Simple brown dress with a grey shawl, black leather shoes, cream bonnet"
    },
    'swiss-constitution': {
      male: "Black formal suit, white shirt with a high collar, black leather shoes, gold pocket watch chain",
      female: "Elegant burgundy dress with a cream lace collar, black leather shoes, small gold brooch"
    },
    'gotthard-tunnel': {
      male: "Off-white work shirt, brown sturdy trousers, heavy brown leather boots, dark red suspenders, grey cloth cap",
      female: "Simple blue work dress with a grey apron, sturdy brown boots, red kerchief"
    },
    'swiss-ww1-neutrality': {
      male: "Swiss military uniform in grey-green, olive puttees, brown leather boots, grey-green kepi cap (carried)",
      female: "White blouse with a dark grey skirt, white Red Cross armband with a red cross, black sensible shoes"
    },
    'general-guisan': {
      male: "Swiss WWII military uniform in grey-green, brown leather boots, brown officer's belt, grey-green peaked cap (carried)",
      female: "Practical navy blue dress with a grey cardigan, brown sensible shoes, white civil defense armband"
    },
    'swiss-ww2-neutrality': {
      male: "Swiss military uniform in grey-green, brown leather boots, brown leather ammunition belt, grey-green field cap (carried)",
      female: "Practical dark green dress with a cream apron, grey cardigan, brown sensible shoes"
    },
    'swiss-womens-vote': {
      male: "1970s brown suit with wide lapels, orange patterned tie, brown leather shoes",
      female: "1970s mustard yellow blouse with a brown A-line skirt, tan sensible shoes, purple protest sash"
    },

    // Exploration & Discovery
    'moon-landing': {
      male: "White NASA spacesuit with a red, white and blue American flag patch, grey life support chest panel, white boots",
      female: "White NASA spacesuit with a red, white and blue American flag patch, grey life support chest panel, white boots"
    },
    'columbus-voyage': {
      male: "Renaissance sailor tunic in faded red, beige loose trousers, brown leather shoes, dark blue cloth cap, hemp-coloured rope belt",
      female: "Cream Renaissance blouse with a dark green laced bodice, long brown skirt, brown leather shoes, white cloth cap"
    },
    'wright-brothers': {
      male: "Early 1900s grey suit with a dark waistcoat, white shirt, black bow tie, black leather shoes, grey newsboy cap",
      female: "Early 1900s white blouse with a long dark blue skirt, black leather boots, simple grey jacket"
    },
    'lindbergh-flight': {
      male: "Brown leather flight jacket, white scarf, brown flight goggles (on forehead), dark brown leather boots",
      female: "Brown leather flight jacket, white scarf, brown flight goggles (on forehead), dark brown leather boots"
    },
    'everest-summit': {
      male: "Thick orange down climbing jacket, black insulated trousers, heavy black climbing boots, dark goggles (on forehead)",
      female: "Thick red down climbing jacket, black insulated trousers, heavy black climbing boots, dark goggles (on forehead)"
    },
    'south-pole': {
      male: "Heavy cream wool sweater, dark green fur-lined anorak, thick grey trousers, brown mukluks, brown mittens",
      female: "Heavy cream wool sweater, dark red fur-lined anorak, thick grey trousers, brown mukluks, brown mittens"
    },
    'magellan-circumnavigation': {
      male: "Renaissance sailor outfit with a cream loose shirt, brown knee breeches, black leather shoes, red cloth sash belt",
      female: "Cream Renaissance blouse, long dark blue skirt, black leather shoes, red cloth sash belt"
    },
    'mariana-trench': {
      male: "Orange deep-sea research jumpsuit, grey utility belt, black waterproof boots",
      female: "Orange deep-sea research jumpsuit, grey utility belt, black waterproof boots"
    },

    // Science & Medicine
    'electricity-discovery': {
      male: "18th century burgundy waistcoat over a white shirt, brown knee breeches, white stockings, black buckle shoes",
      female: "18th century dusty blue dress with cream lace trim, black leather shoes, simple white bonnet"
    },
    'penicillin': {
      male: "White lab coat, pale blue shirt and dark blue tie underneath, black leather shoes, round gold spectacles",
      female: "White lab coat, cream blouse underneath, brown leather shoes, hair pinned up"
    },
    'vaccine-discovery': {
      male: "18th century dark brown doctor's coat, white shirt, cream waistcoat, grey knee breeches, black leather shoes",
      female: "18th century blue-grey dress with a white linen apron, black leather shoes, white bonnet"
    },
    'dna-discovery': {
      male: "1950s white lab coat over a pale blue shirt and a dark blue tie, brown leather shoes, black-framed reading glasses",
      female: "1950s white lab coat over a cream blouse, brown leather shoes, hair pinned neatly"
    },
    'dinosaur-discovery': {
      male: "Victorian field outfit: brown tweed jacket, tan sturdy trousers, dark brown leather boots, khaki canvas satchel",
      female: "Victorian field outfit: practical olive green dress with a cream apron, dark brown leather boots, khaki canvas satchel"
    },
    'einstein-relativity': {
      male: "Rumpled grey tweed suit, white shirt (no tie), wild hair, black leather shoes, white chalk-dusted sleeves",
      female: "Early 1900s white blouse with a long dark grey skirt, black leather shoes, hair in a bun"
    },
    'galapagos-darwin': {
      male: "Victorian naturalist outfit: cream linen shirt, brown waistcoat, tan sturdy trousers, dark brown leather boots, khaki specimen bag",
      female: "Victorian explorer dress in olive green with a cream practical apron, dark brown leather boots, khaki specimen bag"
    },
    'first-heart-transplant': {
      male: "Pale green surgical scrubs, white coat, pale green surgical cap, white comfortable shoes",
      female: "Pale green surgical scrubs, white coat, pale green surgical cap, white comfortable shoes"
    },
    'human-genome': {
      male: "White modern lab coat over a blue casual shirt, clear safety glasses, grey comfortable shoes",
      female: "White modern lab coat over a teal casual blouse, clear safety glasses, grey comfortable shoes"
    },
    'hubble-launch': {
      male: "Blue NASA flight suit with colourful mission patches, black boots, white crew badge",
      female: "Blue NASA flight suit with colourful mission patches, black boots, white crew badge"
    },

    // Inventions
    'telephone-invention': {
      male: "Victorian dark brown suit with a cream waistcoat, white shirt, black cravat, black leather shoes",
      female: "Victorian plum purple dress with a bustle, cream lace collar, black leather boots"
    },
    'light-bulb': {
      male: "Dark grey waistcoat over a white shirt, dark grey trousers, black leather shoes, black bow tie",
      female: "Victorian cream blouse with a long dark green skirt, black leather shoes, simple gold brooch"
    },
    'printing-press': {
      male: "Medieval craftsman's undyed beige tunic, brown leather apron, brown simple leather shoes, grey cloth cap",
      female: "Medieval dark red dress with a cream linen apron, brown leather shoes, white linen head covering"
    },
    'internet-creation': {
      male: "1990s casual: navy blue polo shirt, khaki trousers, white sneakers",
      female: "1990s casual: pale yellow blouse, khaki trousers, white sneakers"
    },

    // Human Rights & Freedom
    'emancipation': {
      male: "Simple off-white cotton shirt, brown suspenders, worn grey-brown trousers, bare feet or simple brown shoes",
      female: "Simple faded blue cotton dress, red and white head wrap, bare feet or simple brown shoes"
    },
    'womens-suffrage': {
      male: "Early 1900s dark grey suit, white shirt, black tie, black leather shoes",
      female: "Early 1900s white blouse with a long dark purple skirt, white sash with green and purple lettering reading 'Votes for Women', black leather boots"
    },
    'rosa-parks': {
      male: "1950s grey suit, white shirt, dark blue tie, grey fedora hat (carried), black leather shoes",
      female: "1950s modest teal dress with a dark grey coat, small black hat, white gloves, black sensible shoes"
    },
    'berlin-wall-fall': {
      male: "1989 casual: blue jeans, light blue denim jacket, white sneakers, red scarf",
      female: "1989 casual: blue jeans, warm green jacket, white sneakers, red scarf"
    },
    'mandela-freedom': {
      male: "Colorful African-print shirt (Madiba shirt) in orange, brown and gold, dark grey trousers, black leather shoes",
      female: "Colorful African-print dress in orange, blue and gold, orange and gold headwrap, black leather shoes"
    },

    // Great Constructions
    'pyramids': {
      male: "White linen kilt (shendyt), tan leather sandals, blue and gold beaded collar, gold arm bands",
      female: "White linen dress, tan leather sandals, blue and gold beaded collar, gold arm bands"
    },
    'eiffel-tower': {
      male: "1880s cream work shirt, brown sturdy trousers, dark brown leather boots, dark red suspenders, grey cloth cap",
      female: "1880s dusty rose dress with a bustle and cream lace trim, dark brown leather boots, cream parasol"
    },
    'panama-canal': {
      male: "Pale blue work shirt, khaki trousers, brown leather boots, beige wide-brimmed hat (carried), red bandana",
      female: "Practical white blouse, khaki skirt, brown leather boots, beige sun bonnet"
    },
    'golden-gate': {
      male: "1930s blue work overalls, red flannel shirt, brown leather boots, grey cloth cap",
      female: "1930s navy blue dress with a grey cardigan, brown sensible shoes, grey cloche hat"
    },
    'channel-tunnel': {
      male: "Modern white construction jumpsuit, bright orange safety vest, black steel-toe boots",
      female: "Modern white construction jumpsuit, bright orange safety vest, black steel-toe boots"
    },

    // Culture & Arts
    'first-olympics': {
      male: "Ancient Greek white athletic tunic (chiton), brown leather sandals, green olive wreath crown",
      female: "Ancient Greek white dress (peplos), brown leather sandals, green olive wreath crown"
    },
    'disneyland-opening': {
      male: "1950s casual: yellow polo shirt, grey slacks, brown and white saddle shoes, crew cut",
      female: "1950s light blue dress with a white petticoat, white bobby socks, brown and white saddle shoes, red hair ribbon"
    },
    'first-movie': {
      male: "1890s dark grey suit with a black bowler hat (carried), cream waistcoat, gold pocket watch chain, black leather shoes",
      female: "1890s dark green dress with a high white collar, cream cameo brooch, black leather boots"
    },
    'first-zoo': {
      male: "Regency-era navy blue tailcoat, white cravat, buff knee breeches, black leather boots",
      female: "Regency-era pale yellow high-waisted dress, cream bonnet, brown leather shoes, white parasol"
    },
    'natural-history-museum': {
      male: "Victorian black suit, black top hat (carried), brown walking cane, black leather shoes",
      female: "Victorian deep blue dress with a bustle, white lace gloves, black leather boots, small black hat"
    },

    // Archaeological Discoveries
    'king-tut': {
      male: "1920s khaki safari suit, brown leather boots, white pith helmet (carried), brown field notebook",
      female: "1920s khaki field outfit, brown leather boots, beige wide-brimmed sun hat, brown field notebook"
    },
    'pompeii-discovery': {
      male: "18th century scholar's outfit: dark green coat, cream waistcoat, brown breeches, black leather shoes, cream sketch pad",
      female: "18th century dusty blue dress with a cream practical apron, black leather shoes, cream sketch pad"
    },
    'terracotta-army': {
      male: "1970s archaeologist outfit: khaki shirt, brown sturdy trousers, brown leather boots, beige sun hat (carried)",
      female: "1970s archaeologist outfit: khaki shirt, brown sturdy trousers, brown leather boots, beige sun hat (carried)"
    }
  }
};

/**
 * Get trial costume for a character based on story topic and category.
 * @param {string} storyTopic - The story topic ID (e.g., 'pirate', 'moon-landing')
 * @param {string} storyCategory - The story category ('adventure', 'historical')
 * @param {string} gender - Character gender ('male', 'female', or empty)
 * @returns {{ costumeType: string, description: string } | null}
 */
function getTrialCostume(storyTopic, storyCategory, gender) {
  const category = storyCategory === 'historical' ? 'historical' : 'adventure';
  const costumes = TRIAL_COSTUMES[category]?.[storyTopic];
  if (!costumes) return null;

  // Default to male if gender not specified or unrecognized
  const genderKey = gender?.toLowerCase() === 'female' ? 'female' : 'male';
  return {
    costumeType: storyTopic,
    description: costumes[genderKey]
  };
}

/**
 * Resolve which topic/category a trial's costume lookup uses.
 * - adventure: storyTheme has the theme (pirate, knight, ...), storyTopic is empty
 * - life-challenge: storyTopic has the challenge, storyTheme has the adventure theme -> use storyTheme
 * - historical: storyTopic has the event ID
 * @param {{storyCategory?: string, storyTheme?: string, storyTopic?: string}} inputs
 * @returns {{ topic: string, category: string }}
 */
function resolveTrialCostumeLookup({ storyCategory, storyTheme, storyTopic } = {}) {
  const isHistorical = storyCategory === 'historical';
  return {
    topic: isHistorical ? (storyTopic || '') : (storyTheme || storyTopic || ''),
    category: isHistorical ? 'historical' : 'adventure'
  };
}

/**
 * getTrialCostume for a set of story inputs — the single place the wizard's
 * category/theme/topic triple is mapped onto the costume table. Every trial
 * consumer (avatar prewarm, story job, idea generation) resolves it the same
 * way, so the premise, the clothing requirements and the avatar sheets cannot
 * disagree about whether a costume exists.
 * @param {{storyCategory?: string, storyTheme?: string, storyTopic?: string, gender?: string}} inputs
 * @returns {{ costumeType: string, description: string } | null}
 */
function getTrialCostumeForStory({ storyCategory, storyTheme, storyTopic, gender } = {}) {
  const { topic, category } = resolveTrialCostumeLookup({ storyCategory, storyTheme, storyTopic });
  return getTrialCostume(topic, category, gender || '');
}

module.exports = { TRIAL_COSTUMES, getTrialCostume, resolveTrialCostumeLookup, getTrialCostumeForStory };
