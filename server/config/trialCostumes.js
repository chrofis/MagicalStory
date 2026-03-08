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
      male: "Striped sailor shirt, brown leather vest, loose canvas trousers tucked into tall boots, wide leather belt with brass buckle",
      female: "Striped sailor blouse, brown leather corset vest, flowing skirt over trousers, tall boots, wide leather belt"
    },
    knight: {
      male: "Silver chain mail tunic over padded gambeson, leather bracers, brown leather boots, simple sword belt",
      female: "Silver chain mail tunic over padded gambeson, leather bracers, brown leather boots, simple sword belt"
    },
    cowboy: {
      male: "Denim jeans, plaid flannel shirt, brown leather vest, cowboy boots with spurs, bandana around neck",
      female: "Denim jeans, plaid flannel shirt, brown leather vest, cowboy boots, bandana around neck"
    },
    ninja: {
      male: "Dark blue traditional ninja outfit (shinobi shozoku), cloth wraps on forearms, soft tabi boots",
      female: "Dark blue traditional ninja outfit (shinobi shozoku), cloth wraps on forearms, soft tabi boots"
    },
    viking: {
      male: "Brown fur-trimmed tunic, leather bracers, thick leather belt with round buckle, fur-lined boots, woolen cloak",
      female: "Long woolen dress with embroidered trim, leather belt with pouch, fur-lined cloak, leather boots"
    },
    roman: {
      male: "White tunic (tunica) with red trim, leather sandals (caligae), leather wrist guards, simple belt",
      female: "White stola dress with golden trim, leather sandals, simple belt with decorative clasp"
    },
    egyptian: {
      male: "White linen kilt (shendyt), gold collar necklace, leather sandals, gold arm bands",
      female: "White linen dress with gold belt, beaded collar necklace, leather sandals, gold arm bands"
    },
    greek: {
      male: "White chiton tunic with blue border, leather sandals, rope belt, simple shoulder clasp",
      female: "White flowing peplos dress with golden trim, leather sandals, golden waist belt"
    },
    caveman: {
      male: "Animal fur tunic, leather cord belt, bare feet or simple leather wraps, bone necklace",
      female: "Animal fur dress, leather cord belt, bare feet or simple leather wraps, shell necklace"
    },
    samurai: {
      male: "Traditional hakama pants, kimono top with family crest, obi sash belt, wooden sandals (geta)",
      female: "Traditional hakama pants, kimono top with floral pattern, obi sash belt, wooden sandals (geta)"
    },
    wizard: {
      male: "Long flowing robe in deep blue with silver star patterns, leather belt with pouch, pointed cloth shoes",
      female: "Long flowing robe in deep purple with golden moon patterns, leather belt with pouch, pointed cloth shoes"
    },
    dragon: {
      male: "Leather armor vest with scale pattern, sturdy boots, arm guards, adventurer's belt with pouches",
      female: "Leather armor vest with scale pattern, sturdy boots, arm guards, adventurer's belt with pouches"
    },
    superhero: {
      male: "Bright colored bodysuit with cape, boots, utility belt, emblem on chest",
      female: "Bright colored bodysuit with cape, boots, utility belt, emblem on chest"
    },
    detective: {
      male: "Tweed jacket, white shirt, brown trousers, polished shoes, magnifying glass on a chain",
      female: "Tweed blazer, white blouse, plaid skirt, polished shoes, magnifying glass on a chain"
    },
    unicorn: {
      male: "Shimmering white tunic with rainbow trim, silver boots, crystal pendant, star-dusted cape",
      female: "Shimmering white dress with rainbow ribbons, silver shoes, crystal tiara, star-dusted cape"
    },
    mermaid: {
      male: "Shimmering scale-pattern vest in sea green, loose trousers, shell necklace, coral arm band",
      female: "Shimmering scale-pattern top in sea green, flowing skirt with fin-like hem, shell necklace, coral tiara"
    },
    dinosaur: {
      male: "Khaki explorer shorts, safari vest with many pockets, hiking boots, adventurer's belt",
      female: "Khaki explorer shorts, safari vest with many pockets, hiking boots, adventurer's belt"
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
      male: "Khaki shorts, green explorer shirt with rolled sleeves, hiking boots, canvas backpack",
      female: "Khaki shorts, green explorer shirt with rolled sleeves, hiking boots, canvas backpack"
    },
    farm: {
      male: "Denim overalls over plaid shirt, rubber boots, straw in pocket",
      female: "Denim overalls over plaid shirt, rubber boots, gardening gloves tucked in pocket"
    },
    forest: {
      male: "Green tunic, brown leather boots, hooded cloak, leather belt with pouch",
      female: "Green tunic dress, brown leather boots, hooded cloak, leather belt with pouch"
    },
    fireman: {
      male: "Yellow firefighter turnout coat with reflective stripes, dark trousers, rubber boots",
      female: "Yellow firefighter turnout coat with reflective stripes, dark trousers, rubber boots"
    },
    doctor: {
      male: "White lab coat over blue scrubs, comfortable shoes, stethoscope around neck",
      female: "White lab coat over blue scrubs, comfortable shoes, stethoscope around neck"
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
      male: "Sparkly formal suit in midnight blue, bow tie, shiny shoes, party hat",
      female: "Sparkly formal dress in midnight blue, shiny shoes, glittery tiara"
    },
    easter: {
      male: "Pastel colored vest over white shirt, light trousers, bow tie, basket",
      female: "Pastel colored dress with flower pattern, white shoes, flower crown"
    },
    halloween: {
      male: "Black cape over dark clothes, spiderweb-patterned vest, dark boots",
      female: "Black cape over dark dress, spiderweb-patterned bodice, dark boots"
    }
  },

  // ══════════════════════════════════════════════════════════════
  // HISTORICAL EVENTS
  // Period costumes extracted from prompts/historical-guides.txt
  // ══════════════════════════════════════════════════════════════
  historical: {
    // Swiss History
    'swiss-founding': {
      male: "Simple woolen tunic, leather belt, fur-lined cloak, leather boots, woolen leggings",
      female: "Long woolen dress with linen apron, leather belt, woolen shawl, leather shoes"
    },
    'wilhelm-tell': {
      male: "Simple farmer's tunic, leather breeches, sturdy boots, woolen cloak, leather belt",
      female: "Long woolen dress with embroidered bodice, white linen apron, leather shoes"
    },
    'battle-morgarten': {
      male: "Padded linen gambeson, leather bracers, simple chain mail vest, leather boots, woolen cloak",
      female: "Long woolen dress with linen apron, leather belt, woolen shawl"
    },
    'battle-sempach': {
      male: "Padded gambeson, leather bracers, chain mail vest, leather boots, cloth surcoat with Swiss cross",
      female: "Long woolen dress with embroidered trim, leather belt, linen head covering"
    },
    'swiss-reformation': {
      male: "Dark scholar's robe, white collar, simple leather shoes, leather belt with book pouch",
      female: "Plain dark dress with white collar and cuffs, linen cap, leather shoes"
    },
    'red-cross-founding': {
      male: "Dark formal suit with white shirt, cravat, leather shoes, top hat (carried)",
      female: "Dark dress with white collar, nurse's apron with red cross, leather shoes"
    },
    'general-dufour': {
      male: "Swiss military uniform with brass buttons, dark blue jacket, white trousers, leather boots",
      female: "Simple dress with white apron, bonnet, leather shoes"
    },
    'sonderbund-war': {
      male: "Swiss military coat with brass buttons, dark trousers, leather boots, peaked cap (carried)",
      female: "Simple dress with shawl, leather shoes, bonnet"
    },
    'swiss-constitution': {
      male: "Formal dark suit, white shirt with high collar, leather shoes, pocket watch chain",
      female: "Elegant dress with lace collar, leather shoes, small brooch"
    },
    'gotthard-tunnel': {
      male: "Work shirt, sturdy trousers, heavy leather boots, suspenders, cloth cap",
      female: "Simple work dress with apron, sturdy boots, kerchief"
    },
    'swiss-ww1-neutrality': {
      male: "Swiss military uniform (grey-green), puttees, leather boots, kepi cap (carried)",
      female: "White blouse with dark skirt, Red Cross armband, sensible shoes"
    },
    'general-guisan': {
      male: "Swiss WWII military uniform, leather boots, officer's belt, peaked cap (carried)",
      female: "Practical dress with cardigan, sensible shoes, civil defense armband"
    },
    'swiss-ww2-neutrality': {
      male: "Swiss military uniform (grey-green), leather boots, ammunition belt, field cap (carried)",
      female: "Practical dress with apron, cardigan, sensible shoes"
    },
    'swiss-womens-vote': {
      male: "1970s suit with wide lapels, patterned tie, leather shoes",
      female: "1970s dress or blouse with A-line skirt, sensible shoes, protest sash"
    },

    // Exploration & Discovery
    'moon-landing': {
      male: "White NASA spacesuit with American flag patch, life support chest panel, white boots",
      female: "White NASA spacesuit with American flag patch, life support chest panel, white boots"
    },
    'columbus-voyage': {
      male: "Renaissance sailor tunic, loose trousers, leather shoes, cloth cap, rope belt",
      female: "Renaissance blouse with laced bodice, long skirt, leather shoes, cloth cap"
    },
    'wright-brothers': {
      male: "Early 1900s suit with waistcoat, white shirt, bow tie, leather shoes, newsboy cap",
      female: "Early 1900s blouse with long skirt, leather boots, simple jacket"
    },
    'lindbergh-flight': {
      male: "Leather flight jacket, white scarf, flight goggles (on forehead), leather boots",
      female: "Leather flight jacket, white scarf, flight goggles (on forehead), leather boots"
    },
    'everest-summit': {
      male: "Thick down climbing jacket, insulated trousers, heavy climbing boots, goggles (on forehead)",
      female: "Thick down climbing jacket, insulated trousers, heavy climbing boots, goggles (on forehead)"
    },
    'south-pole': {
      male: "Heavy wool sweater, fur-lined anorak, thick trousers, mukluks, mittens",
      female: "Heavy wool sweater, fur-lined anorak, thick trousers, mukluks, mittens"
    },
    'magellan-circumnavigation': {
      male: "Renaissance sailor outfit, loose shirt, knee breeches, leather shoes, cloth sash belt",
      female: "Renaissance blouse, long skirt, leather shoes, cloth sash belt"
    },
    'mariana-trench': {
      male: "Deep-sea research jumpsuit, utility belt, waterproof boots",
      female: "Deep-sea research jumpsuit, utility belt, waterproof boots"
    },

    // Science & Medicine
    'electricity-discovery': {
      male: "18th century waistcoat over white shirt, knee breeches, white stockings, buckle shoes",
      female: "18th century dress with lace trim, leather shoes, simple bonnet"
    },
    'penicillin': {
      male: "White lab coat, shirt and tie underneath, leather shoes, round spectacles",
      female: "White lab coat, blouse underneath, leather shoes, hair pinned up"
    },
    'vaccine-discovery': {
      male: "18th century doctor's coat, white shirt, waistcoat, knee breeches, leather shoes",
      female: "18th century dress with linen apron, leather shoes, bonnet"
    },
    'dna-discovery': {
      male: "1950s lab coat over shirt and tie, leather shoes, reading glasses",
      female: "1950s lab coat over blouse, leather shoes, hair pinned neatly"
    },
    'dinosaur-discovery': {
      male: "Victorian field outfit: tweed jacket, sturdy trousers, leather boots, canvas satchel",
      female: "Victorian field outfit: practical dress with apron, leather boots, canvas satchel"
    },
    'einstein-relativity': {
      male: "Rumpled tweed suit, white shirt (no tie), wild hair, leather shoes, chalk-dusted sleeves",
      female: "Early 1900s blouse with long skirt, leather shoes, hair in bun"
    },
    'galapagos-darwin': {
      male: "Victorian naturalist outfit: linen shirt, waistcoat, sturdy trousers, leather boots, specimen bag",
      female: "Victorian explorer dress with practical apron, leather boots, specimen bag"
    },
    'first-heart-transplant': {
      male: "Surgical scrubs, white coat, surgical cap, comfortable shoes",
      female: "Surgical scrubs, white coat, surgical cap, comfortable shoes"
    },
    'human-genome': {
      male: "Modern lab coat over casual shirt, safety glasses, comfortable shoes",
      female: "Modern lab coat over casual blouse, safety glasses, comfortable shoes"
    },
    'hubble-launch': {
      male: "NASA flight suit with mission patches, boots, crew badge",
      female: "NASA flight suit with mission patches, boots, crew badge"
    },

    // Inventions
    'telephone-invention': {
      male: "Victorian suit with waistcoat, white shirt, cravat, leather shoes",
      female: "Victorian dress with bustle, lace collar, leather boots"
    },
    'light-bulb': {
      male: "Dark waistcoat over white shirt, dark trousers, leather shoes, bow tie",
      female: "Victorian blouse with long skirt, leather shoes, simple brooch"
    },
    'printing-press': {
      male: "Medieval craftsman's tunic, leather apron, simple leather shoes, cloth cap",
      female: "Medieval dress with linen apron, leather shoes, linen head covering"
    },
    'internet-creation': {
      male: "1990s casual: polo shirt, khaki trousers, sneakers",
      female: "1990s casual: blouse, khaki trousers, sneakers"
    },

    // Human Rights & Freedom
    'emancipation': {
      male: "Simple cotton shirt, suspenders, worn trousers, bare feet or simple shoes",
      female: "Simple cotton dress, head wrap, bare feet or simple shoes"
    },
    'womens-suffrage': {
      male: "Early 1900s suit, white shirt, tie, leather shoes",
      female: "Early 1900s white blouse with long skirt, sash reading 'Votes for Women', leather boots"
    },
    'rosa-parks': {
      male: "1950s suit, white shirt, tie, fedora hat (carried), leather shoes",
      female: "1950s modest dress with coat, small hat, gloves, sensible shoes"
    },
    'berlin-wall-fall': {
      male: "1989 casual: jeans, denim jacket, sneakers, scarf",
      female: "1989 casual: jeans, warm jacket, sneakers, scarf"
    },
    'mandela-freedom': {
      male: "Colorful African-print shirt (Madiba shirt), dark trousers, leather shoes",
      female: "Colorful African-print dress, headwrap, leather shoes"
    },

    // Great Constructions
    'pyramids': {
      male: "White linen kilt (shendyt), leather sandals, beaded collar, gold arm bands",
      female: "White linen dress, leather sandals, beaded collar, gold arm bands"
    },
    'eiffel-tower': {
      male: "1880s work shirt, sturdy trousers, leather boots, suspenders, cloth cap",
      female: "1880s dress with bustle and lace trim, leather boots, parasol"
    },
    'panama-canal': {
      male: "Work shirt, khaki trousers, leather boots, wide-brimmed hat (carried), bandana",
      female: "Practical blouse, khaki skirt, leather boots, sun bonnet"
    },
    'golden-gate': {
      male: "1930s work overalls, flannel shirt, leather boots, cloth cap",
      female: "1930s dress with cardigan, sensible shoes, cloche hat"
    },
    'channel-tunnel': {
      male: "Modern construction jumpsuit, safety vest, steel-toe boots",
      female: "Modern construction jumpsuit, safety vest, steel-toe boots"
    },

    // Culture & Arts
    'first-olympics': {
      male: "Ancient Greek athletic tunic (chiton), leather sandals, olive wreath crown",
      female: "Ancient Greek dress (peplos), leather sandals, olive wreath crown"
    },
    'disneyland-opening': {
      male: "1950s casual: polo shirt, slacks, saddle shoes, crew cut",
      female: "1950s dress with petticoat, bobby socks, saddle shoes, hair ribbon"
    },
    'first-movie': {
      male: "1890s suit with bowler hat (carried), waistcoat, pocket watch chain, leather shoes",
      female: "1890s dress with high collar, cameo brooch, leather boots"
    },
    'first-zoo': {
      male: "Regency-era tailcoat, white cravat, knee breeches, leather boots",
      female: "Regency-era dress with high waist, bonnet, leather shoes, parasol"
    },
    'natural-history-museum': {
      male: "Victorian suit, top hat (carried), walking cane, leather shoes",
      female: "Victorian dress with bustle, lace gloves, leather boots, small hat"
    },

    // Archaeological Discoveries
    'king-tut': {
      male: "1920s khaki safari suit, leather boots, pith helmet (carried), field notebook",
      female: "1920s khaki field outfit, leather boots, wide-brimmed sun hat, field notebook"
    },
    'pompeii-discovery': {
      male: "18th century scholar's outfit: coat, waistcoat, breeches, leather shoes, sketch pad",
      female: "18th century dress with practical apron, leather shoes, sketch pad"
    },
    'terracotta-army': {
      male: "1970s archaeologist outfit: khaki shirt, sturdy trousers, leather boots, sun hat (carried)",
      female: "1970s archaeologist outfit: khaki shirt, sturdy trousers, leather boots, sun hat (carried)"
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

module.exports = { TRIAL_COSTUMES, getTrialCostume };
