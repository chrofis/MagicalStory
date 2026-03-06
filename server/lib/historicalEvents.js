/**
 * Historical Events for Children's Stories
 *
 * This file contains basic metadata for historical events.
 * Detailed story guidance is in prompts/historical-guides.txt
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
    themes: ['sharing', 'generosity', 'connection', 'changing the world']
  },

  // ============================================
  // SWISS HISTORY
  // ============================================

  'swiss-founding': {
    id: 'swiss-founding',
    name: 'Founding of Switzerland (Rütlischwur)',
    shortName: 'Rütlischwur',
    year: 1291,
    date: 'August 1, 1291',
    location: 'Rütli Meadow, Lake Lucerne, Switzerland',
    category: 'swiss',
    themes: ['unity', 'freedom', 'friendship', 'standing together', 'promise']
  },

  'wilhelm-tell': {
    id: 'wilhelm-tell',
    name: 'Wilhelm Tell and the Apple',
    shortName: 'Wilhelm Tell',
    year: 1307,
    date: 'November 18, 1307 (legend)',
    location: 'Altdorf, Uri, Switzerland',
    category: 'swiss',
    themes: ['courage', 'standing up to bullies', 'father\'s love', 'freedom', 'skill']
  },

  'battle-morgarten': {
    id: 'battle-morgarten',
    name: 'Battle of Morgarten',
    shortName: 'Morgarten',
    year: 1315,
    date: 'November 15, 1315',
    location: 'Morgarten, Zug, Switzerland',
    category: 'swiss',
    themes: ['teamwork', 'clever thinking', 'defending home', 'small vs large']
  },

  'battle-sempach': {
    id: 'battle-sempach',
    name: 'Battle of Sempach and Arnold von Winkelried',
    shortName: 'Sempach',
    year: 1386,
    date: 'July 9, 1386',
    location: 'Sempach, Lucerne, Switzerland',
    category: 'swiss',
    themes: ['sacrifice', 'bravery', 'protecting others', 'unity']
  },

  'swiss-reformation': {
    id: 'swiss-reformation',
    name: 'Zwingli and the Swiss Reformation',
    shortName: 'Swiss Reformation',
    year: 1523,
    date: '1519-1531',
    location: 'Zurich, Switzerland',
    category: 'swiss',
    themes: ['thinking differently', 'standing up for beliefs', 'education', 'change']
  },

  'red-cross-founding': {
    id: 'red-cross-founding',
    name: 'Henry Dunant Founds the Red Cross',
    shortName: 'Red Cross',
    year: 1863,
    date: 'October 29, 1863',
    location: 'Geneva, Switzerland',
    category: 'swiss',
    themes: ['helping others', 'compassion', 'humanity', 'making a difference']
  },

  'general-dufour': {
    id: 'general-dufour',
    name: 'General Dufour and Swiss Unity',
    shortName: 'General Dufour',
    year: 1847,
    date: 'November 1847',
    location: 'Switzerland',
    category: 'swiss',
    themes: ['mercy', 'reconciliation', 'leadership', 'keeping families together']
  },

  'sonderbund-war': {
    id: 'sonderbund-war',
    name: 'The Sonderbund War',
    shortName: 'Sonderbundskrieg',
    year: 1847,
    date: 'November 3-29, 1847',
    location: 'Central Switzerland',
    category: 'swiss',
    themes: ['unity', 'resolving conflicts', 'compromise', 'nation building']
  },

  'swiss-constitution': {
    id: 'swiss-constitution',
    name: 'Swiss Federal Constitution',
    shortName: 'Bundesverfassung',
    year: 1848,
    date: 'September 12, 1848',
    location: 'Bern, Switzerland',
    category: 'swiss',
    themes: ['democracy', 'unity in diversity', 'fairness', 'new beginnings']
  },

  'gotthard-tunnel': {
    id: 'gotthard-tunnel',
    name: 'Building the Gotthard Railway Tunnel',
    shortName: 'Gotthard Tunnel',
    year: 1882,
    date: 'May 22, 1882',
    location: 'Swiss Alps (Göschenen to Airolo)',
    category: 'swiss',
    themes: ['engineering', 'perseverance', 'international cooperation', 'connecting people']
  },

  'swiss-ww1-neutrality': {
    id: 'swiss-ww1-neutrality',
    name: 'Switzerland Stays Neutral in WWI',
    shortName: 'Swiss Neutrality WWI',
    year: 1914,
    date: '1914-1918',
    location: 'Switzerland',
    category: 'swiss',
    themes: ['peace', 'helping refugees', 'staying united', 'humanitarian aid']
  },

  'general-guisan': {
    id: 'general-guisan',
    name: 'General Guisan and the Rütli Report',
    shortName: 'General Guisan',
    year: 1940,
    date: 'July 25, 1940',
    location: 'Rütli Meadow, Switzerland',
    category: 'swiss',
    themes: ['leadership', 'courage', 'unity', 'defending freedom', 'determination']
  },

  'swiss-ww2-neutrality': {
    id: 'swiss-ww2-neutrality',
    name: 'Switzerland in World War II',
    shortName: 'Swiss WWII',
    year: 1939,
    date: '1939-1945',
    location: 'Switzerland',
    category: 'swiss',
    themes: ['protecting borders', 'helping refugees', 'staying neutral', 'difficult choices']
  },

  'swiss-womens-vote': {
    id: 'swiss-womens-vote',
    name: 'Swiss Women Win the Right to Vote',
    shortName: 'Swiss Women Vote',
    year: 1971,
    date: 'February 7, 1971',
    location: 'Switzerland',
    category: 'swiss',
    themes: ['equality', 'perseverance', 'democracy', 'never giving up', 'fairness']
  },

  'human-genome': {
    id: 'human-genome',
    name: 'Human Genome Decoded',
    shortName: 'Human Genome Project',
    year: 2003,
    date: 'April 14, 2003',
    location: 'International collaboration',
    category: 'science',
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

// Categories for UI
const EVENT_CATEGORIES = [
  { id: 'swiss', name: 'Swiss History', icon: '🇨🇭' },
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
  getRandomEvents
};
