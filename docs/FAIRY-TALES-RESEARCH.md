# Fairy Tales (Märchen) — Story Category Research

**Last updated**: March 2026
**Status**: Research only — no code changes yet

This document collects fairy tale information for a potential new "Märchen" story category, structured similarly to the existing historical events system.

## How It Would Work

Like historical stories, each fairy tale would have:
- An event ID (e.g., `cinderella`, `devils-bridge`)
- A teaching/story guide in `prompts/fairytale-guides.txt`
- Frontend topic selection in `client/src/constants/storyTypes.ts`
- Optional: pre-fetched location photos (for Swiss tales with real landmarks)

Key difference from historical: the child characters **become** the fairy tale characters (participant mode), or the fairy tale happens around them. The AI adapts the classic story to feature the child's name, appearance, and companions.

---

## Swiss Fairy Tales & Legends

These are unique to Switzerland and give the product a differentiator. Many have real locations that could use pre-fetched photos.

### 1. heidi
**Name:** Heidi
**Origin:** Johanna Spyri (1881, Switzerland)
**Summary:** An orphan girl is sent to live with her gruff grandfather in the Swiss Alps. She befriends goatherd Peter and discovers the joy of mountain life. Later she helps heal a disabled girl named Klara who visits from Frankfurt.
**Key Characters:** Heidi, Grandfather (Alm-Öhi), Peter the goatherd, Klara, Peter's Grandmother
**Settings:** Alpine meadows above Maienfeld, a mountain hut, goat pastures, Frankfurt (city contrast)
**Real Locations:** Maienfeld (GR), Heididorf museum, the Alp above Maienfeld
**Themes:** Nature heals, kindness transforms hearts, home is where you belong
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — Swiss Alps, wildflowers, goats, cozy wooden hut, panoramic views

### 2. devils-bridge
**Name:** The Devil's Bridge (Teufelsbrücke)
**Origin:** Swiss folk legend (Schöllenen Gorge, Canton Uri)
**Summary:** Villagers desperately need a bridge across a dangerous gorge. The Devil offers to build it but demands the soul of the first to cross. The clever villagers trick him by sending a goat across first. The furious Devil throws a boulder but misses.
**Key Characters:** The Devil, clever villagers, the goat
**Settings:** Schöllenen Gorge near Andermatt, the rushing Reuss River, a dramatic stone bridge
**Real Locations:** Teufelsbrücke (Schöllenen Gorge, UR), Devil's Stone (Teufelsstein), Andermatt
**Themes:** Cleverness outwits power, community problem-solving
**Age:** 5+
**Softening needed:** Mild — portray Devil as silly/outwitted, not scary
**Visual appeal:** Excellent — dramatic gorge, rushing waterfall, stone bridge, comic Devil with a goat

### 3. dragons-pilatus
**Name:** The Dragons of Mount Pilatus (Die Drachen vom Pilatus)
**Origin:** Swiss folk legend (Lucerne region)
**Summary:** Friendly dragons with magical healing powers live in caves on Mount Pilatus. A farmer witnesses a great dragon fly into the mountain and discovers the legendary Dragon Stone, said to have the power to heal the sick.
**Key Characters:** The Dragons, the Farmer, townspeople of Lucerne
**Settings:** Mount Pilatus, Lake Lucerne, mountain caves
**Real Locations:** Mount Pilatus, Lake Lucerne, Pilatus Kulm
**Themes:** Don't judge by appearances, nature holds hidden wonders
**Age:** 3+
**Softening needed:** No — these are friendly, healing dragons
**Visual appeal:** Excellent — friendly dragons over Alpine peaks, crystal-clear lake, healing stones

### 4. st-gall-bear
**Name:** St. Gall and the Bear (Sankt Gallus und der Bär)
**Origin:** Swiss legend (7th century, Canton St. Gallen)
**Summary:** Irish monk Gallus travels to the Swiss wilderness. He encounters a large bear but instead of fighting, shares his bread. The grateful bear helps carry logs and build a shelter. The town of St. Gallen grew around the monastery built on that spot.
**Key Characters:** St. Gallus (the monk), the Bear
**Settings:** Swiss forest wilderness, a clearing by a stream, the beginnings of a monastery
**Real Locations:** Abbey of St. Gall (UNESCO World Heritage), St. Gallen old town
**Themes:** Kindness tames wild creatures, sharing creates friendship
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — monk and bear sharing bread, forest, building together

### 5. vogel-gryff
**Name:** Vogel Gryff of Basel
**Origin:** Basel folk tradition (centuries old, still celebrated annually in January)
**Summary:** Three magical creatures — the Vogel Gryff (griffin), the Wild Man, and the Lion — represent the guilds of Basel. Once a year they dance on the bridge over the Rhine, celebrating the spirit of the city.
**Key Characters:** Vogel Gryff (Griffin), Wild Maa (Wild Man), Leu (Lion)
**Settings:** The Rhine River, Basel's Mittlere Brücke (Middle Bridge), the old town
**Real Locations:** Mittlere Brücke Basel, Kleinbasel, the Rhine
**Themes:** Community celebration, tradition brings people together
**Age:** 3+
**Softening needed:** No — festive and joyful
**Visual appeal:** Excellent — griffin, wild man, and lion dancing on a medieval bridge over a river

### 6. white-chamois
**Name:** The White Chamois (Die weisse Gämse)
**Origin:** Swiss Alpine folk legend
**Summary:** A legendary white chamois lives on the highest peaks. Hunters who chase it selfishly are led to danger, but those with pure hearts are guided to safety by the magical creature.
**Key Characters:** The White Chamois, Alpine hunters, mountain villagers
**Settings:** High Alpine peaks, rocky cliffs, mountain paths
**Real Locations:** Various Swiss Alpine peaks (Bernese Oberland, Valais)
**Themes:** Respect nature, greed leads to danger, pure hearts find their way
**Age:** 4+
**Softening needed:** No
**Visual appeal:** Excellent — gleaming white chamois leaping across snowy peaks

### 7. frost-giants
**Name:** The Frost Giants and the Sunbeam Fairies (Die Frostriesen und die Sonnenelfen)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** Switzerland was a frozen wasteland ruled by cruel Frost Giants. The Fairy Queen and the Sun send an army of Sunbeam Fairies to battle the giants, melting the ice and transforming the land into a green paradise with flowers and meadows.
**Key Characters:** The Frost Giants, the Fairy Queen, the Sunbeam Fairies, the Sun
**Settings:** Frozen Swiss mountains, glaciers turning into meadows, Alpine flower fields
**Themes:** Light triumphs over cold, beauty grows from harsh beginnings
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — glaciers, tiny glowing fairies, frozen giants, flowers blooming in snow

### 8. cuckoo-clock-fairy
**Name:** The Fairy in the Cuckoo Clock (Die Fee in der Kuckucksuhr)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** A mischievous fairy discovers Swiss woodworkers' clever clock mechanisms. She enchants a wooden bird to pop out and call "cuckoo" at every hour, delighting the villagers. This is how the first cuckoo clock was born.
**Key Characters:** The Fairy, Swiss woodworker, the cuckoo bird
**Settings:** A Swiss woodworker's workshop, a mountain village
**Themes:** Magic and craftsmanship create wonder
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — cuckoo clock mechanics, tiny fairy, cozy workshop

### 9. edelweiss-fairy
**Name:** The Fairy of the Edelweiss (Die Edelweissfee)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** A brave fairy is transformed by the Fairy Queen into the first Edelweiss flower to stand guard against the Frost King on the highest mountain peaks. The small fuzzy white flower grows where almost nothing else can, symbolizing courage and love.
**Key Characters:** The Fairy, the Fairy Queen, the Frost King
**Settings:** High Alpine peaks, rocky mountain ledges, snow-covered cliffs
**Themes:** Bravery means standing firm in hard places, small things hold great courage
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — Edelweiss on dramatic cliffsides, fairy transforming, mountain vistas

### 10. alpine-horn
**Name:** The Wonderful Alpine Horn (Das wunderbare Alphorn)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** A young shepherd boy named Perrod receives a magical Alpine horn from mysterious mountain visitors. When he plays it, the sound echoes through the valleys, bringing joy to everyone and calling the cows safely home.
**Key Characters:** Perrod (shepherd boy), mysterious mountain visitors, villagers
**Settings:** Alpine pastures, mountain valleys, a Swiss village
**Themes:** Music brings people together, gifts should help others
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — boy playing alphorn with mountain echoes, cows coming home, Alpine sunset

### 11. dwarf-chocolate
**Name:** The Dwarf and His Confectionery (Der Zwerg und sein Süsswarenladen)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** A dairy farmer discovers that the Dwarf King has a secret underground workshop making wonderful candy and chocolate. The farmer tries to steal the recipe but is caught and learns about honesty and respect.
**Key Characters:** The Dwarf King, the Dairy Farmer, underground dwarf helpers
**Settings:** Swiss mountain pastures, a hidden underground confectionery cavern
**Themes:** Respect others' work, greed leads to trouble
**Age:** 4+
**Softening needed:** No
**Visual appeal:** Excellent — hidden underground candy workshop, dwarves making chocolate. Connects to Switzerland's chocolate tradition.

### 12. palace-under-waves
**Name:** The Palace Under the Waves (Der Palast unter den Wellen)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** The king of the water spirits invites a human princess into his crystal palace beneath a Swiss lake. She discovers an enchanted world of shimmering halls and water gardens, and must choose between the magical underwater world and her life above.
**Key Characters:** The Water King, the Princess, lake spirits
**Settings:** A Swiss lake shore, a crystal palace underwater, water gardens
**Themes:** Every world has its own beauty, be grateful for where you belong
**Age:** 4+
**Softening needed:** No
**Visual appeal:** Excellent — crystal underwater palace, Swiss lake, shimmering water spirits

### 13. friendly-dragons
**Name:** Two Good-Natured Dragons (Zwei gutmütige Drachen)
**Origin:** William Elliot Griffis collection (1920)
**Summary:** A man lost in a mountain storm stumbles into a cave and discovers two friendly dragons. Instead of being frightening, they keep him warm through the winter and share their food.
**Key Characters:** The lost traveler, two friendly dragons
**Settings:** Swiss mountain cave, stormy Alpine landscape
**Themes:** Don't judge by appearances, kindness in unexpected places
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — cozy dragon cave, friendly dragons, snowy mountains, warm firelight

### 14. gargantua-matterhorn
**Name:** The Gargantua of the Matterhorn
**Origin:** Swiss Alpine legend
**Summary:** A legendary giant named Gargantua shaped the Swiss landscape as he walked. His footprints became lakes, and when he lay down to rest, his body became the Matterhorn.
**Key Characters:** Gargantua the Giant
**Settings:** The Matterhorn, Swiss valleys and lakes
**Themes:** Even the mightiest things have a story behind them
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — giant walking through the Alps, footprints becoming lakes, the Matterhorn forming

---

## Classic European Fairy Tales

The most well-known fairy tales worldwide. Parents recognize these instantly.

### 15. cinderella
**Name:** Cinderella / Aschenputtel (DE) / Cendrillon (FR)
**Origin:** Charles Perrault (1697) / Brothers Grimm
**Summary:** A kind girl mistreated by her stepmother and stepsisters attends a royal ball with help from a fairy godmother, wins the prince's heart, and is identified by a lost glass slipper.
**Key Characters:** Cinderella, Fairy Godmother, Prince Charming, Wicked Stepmother, Stepsisters
**Settings:** A manor house, the royal palace ballroom, a pumpkin carriage
**Themes:** Kindness and inner beauty triumph over cruelty
**Age:** 3+
**Softening needed:** Mild — use Perrault version (no violent punishment for stepsisters)
**Visual appeal:** Excellent — ball gown transformation, pumpkin carriage, glass slipper, grand palace

### 16. snow-white
**Name:** Snow White / Schneewittchen (DE)
**Origin:** Brothers Grimm (1812)
**Summary:** A princess flees her jealous stepmother and finds refuge with seven kind dwarfs. The Queen tricks her with a poisoned apple, but true love breaks the spell.
**Key Characters:** Snow White, the Evil Queen, the Seven Dwarfs, the Prince, the Magic Mirror
**Settings:** Dark enchanted forest, the dwarfs' cozy cottage, the Queen's castle
**Themes:** Jealousy leads to downfall, kindness attracts friendship
**Age:** 4+
**Softening needed:** Yes — soften poisoning to sleeping spell, remove violent punishments
**Visual appeal:** Excellent — magical mirror, forest cottage, seven distinct dwarfs, apple, castle

### 17. sleeping-beauty
**Name:** Sleeping Beauty / Dornröschen (DE) / La Belle au bois dormant (FR)
**Origin:** Charles Perrault (1697) / Brothers Grimm
**Summary:** A princess is cursed by an evil fairy to fall into a deep sleep for 100 years. A good fairy softens the curse, and a brave prince eventually wakes her with true love's kiss.
**Key Characters:** Princess Aurora, Evil Fairy, Good Fairies, Prince, King and Queen
**Settings:** Royal palace, an overgrown castle covered in thorns and roses, the spindle room
**Themes:** Good triumphs over evil, love conquers curses
**Age:** 4+
**Softening needed:** Mild — omit Perrault's dark second half
**Visual appeal:** Excellent — fairy christening, thorn-covered castle, sleeping princess

### 18. red-riding-hood
**Name:** Little Red Riding Hood / Rotkäppchen (DE)
**Origin:** Charles Perrault (1697) / Brothers Grimm
**Summary:** A girl in a red cloak visits her grandmother but encounters a cunning wolf who tricks her. A brave woodsman rescues both grandmother and Red Riding Hood.
**Key Characters:** Little Red Riding Hood, the Big Bad Wolf, Grandmother, the Woodsman
**Settings:** A forest path, Grandmother's cottage in the woods
**Themes:** Listen to your parents, don't talk to strangers, appearances deceive
**Age:** 4+
**Softening needed:** Yes — use Grimm version with rescue, soften "swallowing" to "trapping"
**Visual appeal:** Excellent — red cloak in green forest, wolf in grandmother's clothing, cozy cottage

### 19. hansel-gretel
**Name:** Hansel and Gretel / Hänsel und Gretel (DE)
**Origin:** Brothers Grimm (1812)
**Summary:** Two siblings lost in the forest discover a house made of candy. A wicked witch captures them, but clever Gretel outwits her and frees her brother.
**Key Characters:** Hansel, Gretel, the Witch, Father
**Settings:** Deep dark forest, gingerbread/candy house, the witch's oven
**Themes:** Siblings working together overcome anything, cleverness defeats evil
**Age:** 5+
**Softening needed:** Yes — children get lost (not abandoned), witch is defeated/banished (not burned)
**Visual appeal:** Excellent — gingerbread house is one of the most iconic fairy tale images

### 20. rapunzel
**Name:** Rapunzel
**Origin:** Brothers Grimm (1812)
**Summary:** A girl with incredibly long golden hair is locked in a tower by an enchantress. A prince discovers her singing, climbs her hair, and together they escape.
**Key Characters:** Rapunzel, the Prince, Dame Gothel (enchantress)
**Settings:** A tall stone tower in the forest, the enchantress's garden
**Themes:** Love and courage overcome imprisonment, freedom is precious
**Age:** 4+
**Softening needed:** Yes — simplify to escape story, remove dark elements
**Visual appeal:** Excellent — iconic long golden hair from a tower, magical garden

### 21. frog-prince
**Name:** The Frog Prince / Der Froschkönig (DE)
**Origin:** Brothers Grimm
**Summary:** A princess drops her golden ball into a well. A frog retrieves it in exchange for friendship. When she keeps her promise, the frog transforms into a prince.
**Key Characters:** The Princess, the Frog/Prince, the King
**Settings:** A castle, a well in a garden, the royal dining hall
**Themes:** Keep your promises, don't judge by appearance
**Age:** 3+
**Softening needed:** Mild — use "kiss" version, not "throw against wall"
**Visual appeal:** Good — golden ball, well, frog with tiny crown, transformation

### 22. beauty-beast
**Name:** Beauty and the Beast / La Belle et la Bête (FR)
**Origin:** Gabrielle-Suzanne de Villeneuve (1740, France)
**Summary:** Belle goes to live in an enchanted castle with a fearsome Beast to save her father. She discovers his gentle heart, and her love breaks the curse.
**Key Characters:** Belle, the Beast/Prince, Belle's Father, enchanted servants
**Settings:** An enchanted castle, a magical rose garden, Belle's village
**Themes:** True beauty is within, love transforms
**Age:** 4+
**Softening needed:** No — naturally gentle
**Visual appeal:** Excellent — enchanted castle, magical rose, transformation, ballroom

### 23. rumpelstiltskin
**Name:** Rumpelstiltskin / Rumpelstilzchen (DE)
**Origin:** Brothers Grimm
**Summary:** A mysterious little man helps a girl spin straw into gold but demands her firstborn child. She escapes the deal by guessing his name.
**Key Characters:** The Miller's Daughter/Queen, Rumpelstiltskin, the King
**Settings:** A castle room with a spinning wheel, the forest
**Themes:** Cleverness solves impossible problems
**Age:** 5+
**Softening needed:** Yes — he stomps and disappears (doesn't tear himself apart)
**Visual appeal:** Good — spinning wheel, gold thread, little man dancing by firelight

### 24. little-mermaid
**Name:** The Little Mermaid / Den lille Havfrue (DA)
**Origin:** Hans Christian Andersen (1837, Denmark)
**Summary:** A mermaid princess trades her voice to a sea witch for human legs, hoping to win the love of a prince she rescued from a shipwreck.
**Key Characters:** The Little Mermaid, the Prince, the Sea Witch, Mermaid's Sisters
**Settings:** An underwater palace, the ocean surface, a coastal kingdom
**Themes:** Follow your dreams, be true to yourself
**Age:** 5+
**Softening needed:** Yes — use happy ending (not dissolving into sea foam)
**Visual appeal:** Excellent — underwater kingdom, shimmering tail, sea creatures, coastal castle

### 25. ugly-duckling
**Name:** The Ugly Duckling / Das hässliche Entlein (DE)
**Origin:** Hans Christian Andersen (1843, Denmark)
**Summary:** A little bird mocked for looking different endures hardship through the seasons, then discovers he has grown into a beautiful swan.
**Key Characters:** The Ugly Duckling/Swan, Mother Duck, other ducklings, farm animals
**Settings:** A farm pond, a frozen lake in winter, a spring garden with swans
**Themes:** You are beautiful as you are, patience reveals your true self
**Age:** 3+
**Softening needed:** No — frame bullying scenes gently
**Visual appeal:** Excellent — duckling on pond, seasonal changes, stunning swan transformation

### 26. thumbelina
**Name:** Thumbelina / Däumelinchen (DE)
**Origin:** Hans Christian Andersen (1835, Denmark)
**Summary:** A tiny girl no bigger than a thumb is born from a magical flower. She has adventures with a toad, beetle, field mouse, and mole before a swallow carries her to a land of flower fairies.
**Key Characters:** Thumbelina, the Toad, the Field Mouse, the Mole, the Swallow, the Flower Prince
**Settings:** A flower garden, a lily pad, an underground burrow, a sunny land of flowers
**Themes:** Stay true to yourself, kindness is rewarded
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — tiny girl on a flower, lily pad boats, flying on a swallow

### 27. snow-queen
**Name:** The Snow Queen / Die Schneekönigin (DE)
**Origin:** Hans Christian Andersen (1844, Denmark)
**Summary:** When Kai is enchanted and kidnapped by the Snow Queen, his brave friend Gerda journeys across snowy lands to rescue him using the power of love and friendship.
**Key Characters:** Gerda, Kai, the Snow Queen, the Robber Girl, the Reindeer
**Settings:** A snowy village, a river journey, a robber's camp, the Snow Queen's ice palace
**Themes:** True friendship overcomes any coldness
**Age:** 5+
**Softening needed:** Mild — tone down kidnapping/robbers
**Visual appeal:** Excellent — ice palace, snow landscapes, sledge rides, flower gardens

### 28. emperors-clothes
**Name:** The Emperor's New Clothes / Des Kaisers neue Kleider (DE)
**Origin:** Hans Christian Andersen (1837, Denmark)
**Summary:** Swindler tailors convince a vain emperor they're making magnificent invisible clothes. Everyone pretends to see them until a child declares "The Emperor has no clothes!"
**Key Characters:** The Emperor, the Two Swindlers, the Little Child, Townspeople
**Settings:** A royal palace, the streets during a procession
**Themes:** Honesty is important, children see the truth
**Age:** 3+
**Softening needed:** No — naturally humorous
**Visual appeal:** Good — ridiculous parade, fancy palace, humorous expressions

### 29. princess-pea
**Name:** The Princess and the Pea / Die Prinzessin auf der Erbse (DE)
**Origin:** Hans Christian Andersen (1835, Denmark)
**Summary:** A prince searches for a real princess. A girl arrives on a stormy night; the queen tests her by placing a pea under twenty mattresses. She feels it, proving she's a true princess.
**Key Characters:** The Princess, the Prince, the Queen
**Settings:** A royal castle, a bedroom with a towering stack of mattresses
**Themes:** True quality shines through
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — towering stack of mattresses is an iconic image

### 30. puss-in-boots
**Name:** Puss in Boots / Der gestiefelte Kater (DE)
**Origin:** Charles Perrault (1697, France)
**Summary:** A clever cat helps a poor young man become rich and marry a princess through wit and a pair of fancy boots. The cat outsmarts an ogre and wins his master a castle.
**Key Characters:** Puss in Boots, the Miller's Son, the Princess, the Ogre, the King
**Settings:** A mill, rolling countryside, the Ogre's castle, the King's carriage
**Themes:** Cleverness changes your fortune
**Age:** 4+
**Softening needed:** No — mild trickery only
**Visual appeal:** Excellent — cat in boots and feathered hat, castle, carriage

### 31. goldilocks
**Name:** Goldilocks and the Three Bears
**Origin:** English folk tale (Robert Southey, 1837)
**Summary:** Curious Goldilocks wanders into the home of three bears while they're out. She tries their porridge, chairs, and beds, finding one "just right" each time. The bears return to find her sleeping.
**Key Characters:** Goldilocks, Papa Bear, Mama Bear, Baby Bear
**Settings:** A cozy cottage in the woods with three of everything
**Themes:** Respect others' property, ask before you take
**Age:** 3+
**Softening needed:** No — one of the gentlest fairy tales
**Visual appeal:** Excellent — "three of everything" visual pattern, cozy bear cottage

### 32. three-little-pigs
**Name:** The Three Little Pigs
**Origin:** English folk tale (James Halliwell-Phillipps, 1886)
**Summary:** Three pig brothers each build a house — straw, sticks, and bricks. The Big Bad Wolf blows down the first two but cannot blow down the brick house.
**Key Characters:** Three Little Pigs, the Big Bad Wolf
**Settings:** Three houses (straw, sticks, bricks), countryside
**Themes:** Hard work pays off, don't take shortcuts
**Age:** 3+
**Softening needed:** Mild — pigs escape to next house (not eaten), wolf gives up (not boiled)
**Visual appeal:** Excellent — three distinct houses, huffing wolf, cozy brick house

### 33. jack-beanstalk
**Name:** Jack and the Beanstalk
**Origin:** English folk tale (1734)
**Summary:** A poor boy trades his cow for magic beans. A giant beanstalk grows overnight. Jack climbs it and discovers a giant's castle in the clouds with a golden harp and a goose that lays golden eggs.
**Key Characters:** Jack, Jack's Mother, the Giant, the Giant's Wife, the Golden Goose
**Settings:** A poor cottage, a towering beanstalk, a castle above the clouds
**Themes:** Bravery and cleverness overcome the biggest challenges
**Age:** 4+
**Softening needed:** Mild — tone down "Fee-fi-fo-fum" threat
**Visual appeal:** Excellent — giant beanstalk, castle in clouds, golden goose

### 34. pinocchio
**Name:** Pinocchio / Le avventure di Pinocchio (IT)
**Origin:** Carlo Collodi (1883, Italy)
**Summary:** A wooden puppet carved by kindly Geppetto dreams of becoming a real boy. His nose grows when he lies. Through adventures guided by a fairy and a talking cricket, he learns honesty and courage.
**Key Characters:** Pinocchio, Geppetto, the Blue Fairy, Jiminy Cricket
**Settings:** Geppetto's workshop, a puppet theater, inside a whale
**Themes:** Honesty, courage, unselfishness make you "real"
**Age:** 4+
**Softening needed:** Yes — use Disney-style version, original is very dark
**Visual appeal:** Excellent — wooden puppet, growing nose, workshop, whale scene, transformation

### 35. bremen-musicians
**Name:** The Bremen Town Musicians / Die Bremer Stadtmusikanten (DE)
**Origin:** Brothers Grimm
**Summary:** Four aging animals — donkey, dog, cat, rooster — run away and set off to become musicians. They scare off robbers by standing on each other's backs and making tremendous noise.
**Key Characters:** Donkey, Dog, Cat, Rooster, the Robbers
**Settings:** A road to Bremen, the robbers' house in the forest
**Themes:** Teamwork, you're never too old for adventure
**Age:** 3+
**Softening needed:** No — gentle and humorous
**Visual appeal:** Excellent — four stacked animals is an iconic image

### 36. elves-shoemaker
**Name:** The Elves and the Shoemaker / Die Wichtelmänner (DE)
**Origin:** Brothers Grimm
**Summary:** A poor shoemaker finds that tiny elves come at night to make beautiful shoes. He and his wife thank them by making tiny clothes for the elves.
**Key Characters:** The Shoemaker, his Wife, the Elves
**Settings:** A small shoe workshop, nighttime candlelight
**Themes:** Kindness is repaid, gratitude matters
**Age:** 3+
**Softening needed:** No
**Visual appeal:** Excellent — tiny elves working by candlelight, beautiful miniature shoes

---

## World Fairy Tales

Well-known tales from other cultures, adding diversity.

### 37. aladdin
**Name:** Aladdin and the Magic Lamp / Aladin und die Wunderlampe (DE)
**Origin:** One Thousand and One Nights (Arabian Nights)
**Summary:** A poor young man discovers a magical lamp in a cave. A powerful genie grants wishes. Aladdin must protect the lamp from a wicked sorcerer while winning a princess's heart.
**Key Characters:** Aladdin, the Genie, the Princess, the Wicked Sorcerer
**Settings:** A Middle Eastern marketplace, a cave of wonders, a desert palace
**Themes:** Kindness matters more than riches, be careful what you wish for
**Age:** 4+
**Softening needed:** Mild — reduce violent confrontations
**Visual appeal:** Excellent — magic lamp, cave of treasures, flying carpet, genie, desert palace

### 38. momotaro
**Name:** Momotaro (Peach Boy)
**Origin:** Japanese folk tale (one of Japan's "Five Great Fairy Tales")
**Summary:** An elderly couple find a giant peach in the river with a baby boy inside. Momotaro grows strong and sets out to defeat demons (Oni), befriending a dog, monkey, and pheasant along the way.
**Key Characters:** Momotaro, the Elderly Couple, the Dog, the Monkey, the Pheasant, the Oni
**Settings:** A riverside village, countryside, Onigashima (Demon Island)
**Themes:** Bravery, friendship, sharing bring victory
**Age:** 4+
**Softening needed:** Mild — portray Oni as silly rather than scary
**Visual appeal:** Excellent — giant peach, boy with animal friends, Japanese landscape

### 39. monkey-king
**Name:** The Monkey King (Sun Wukong)
**Origin:** Journey to the West, Wu Cheng'en (16th century, China)
**Summary:** Born from a magical stone egg, the Monkey King gains incredible powers. After causing havoc in heaven, he's imprisoned under a mountain, then redeemed by joining a monk's journey to find sacred scriptures.
**Key Characters:** Sun Wukong (Monkey King), Xuanzang (the Monk), Pigsy, Sandy
**Settings:** Flower Fruit Mountain, the Heavenly Palace, the road westward
**Themes:** Even the mightiest must learn humility, redemption through helping others
**Age:** 5+
**Softening needed:** Mild — select child-friendly episodes
**Visual appeal:** Excellent — stone egg hatching, cloud-riding monkey, golden staff, Chinese landscapes

### 40. mulan
**Name:** Mulan / Hua Mulan
**Origin:** Chinese folk ballad (6th century)
**Summary:** When her aging father is called to serve in the army, brave young Mulan disguises herself as a man and goes in his place. She serves with distinction and returns home a hero.
**Key Characters:** Mulan, her Father, fellow soldiers, the Emperor
**Settings:** A Chinese village, army camps, the Emperor's court
**Themes:** Courage knows no gender, love for family inspires bravery
**Age:** 5+
**Softening needed:** Mild — downplay war, focus on bravery and family love
**Visual appeal:** Excellent — Chinese village, armor and horses, cherry blossoms, Emperor's palace

### 41. anansi
**Name:** Anansi the Spider
**Origin:** Ashanti/Akan folk tradition (West Africa, Ghana)
**Summary:** Clever spider Anansi captures all the world's stories from the Sky God by outsmarting a python, a leopard, and a hornet, earning the right to be keeper of all stories.
**Key Characters:** Anansi the Spider, the Sky God (Nyame), Python, Leopard, Hornet
**Settings:** The African forest, a spider's web, the Sky God's domain
**Themes:** Wit accomplishes what strength cannot, stories are the greatest treasure
**Age:** 4+
**Softening needed:** No — naturally child-friendly trickster tales
**Visual appeal:** Good — colorful spider, African forest, web designs, diverse animals

### 42. tortoise-hare
**Name:** The Tortoise and the Hare
**Origin:** Aesop's Fables (ancient Greek, ~600 BC)
**Summary:** A boastful hare challenges a slow tortoise to a race. The hare naps mid-race, confident of victory. The steady tortoise keeps going and crosses the finish line first.
**Key Characters:** The Tortoise, the Hare, forest animal spectators
**Settings:** A countryside racecourse through fields and forests
**Themes:** Slow and steady wins the race, don't be overconfident
**Age:** 3+
**Softening needed:** No — one of the gentlest fables
**Visual appeal:** Excellent — racing animals, sleeping hare, determined tortoise, cheering crowd

### 43. ali-baba
**Name:** Ali Baba and the Forty Thieves
**Origin:** One Thousand and One Nights (Arabian Nights)
**Summary:** A poor woodcutter discovers the secret cave of forty thieves with the magic words "Open Sesame!" His clever servant Morgiana helps him outsmart the thieves.
**Key Characters:** Ali Baba, Morgiana, the Thieves' Leader, the Forty Thieves
**Settings:** A desert cave entrance, a Middle Eastern town
**Themes:** Cleverness and loyalty are worth more than gold
**Age:** 6+
**Softening needed:** Yes — simplify to discovery and outwitting (remove violence)
**Visual appeal:** Excellent — magical cave opening, piles of treasure, "Open Sesame" moment

---

## Summary Table

| # | ID | Name | Category | Origin | Age | Softening | Visual |
|---|-----|------|----------|--------|-----|-----------|--------|
| 1 | heidi | Heidi | Swiss | Spyri | 3+ | No | Excellent |
| 2 | devils-bridge | The Devil's Bridge | Swiss | Legend | 5+ | Mild | Excellent |
| 3 | dragons-pilatus | Dragons of Pilatus | Swiss | Legend | 3+ | No | Excellent |
| 4 | st-gall-bear | St. Gall and the Bear | Swiss | Legend | 3+ | No | Excellent |
| 5 | vogel-gryff | Vogel Gryff Basel | Swiss | Tradition | 3+ | No | Excellent |
| 6 | white-chamois | The White Chamois | Swiss | Legend | 4+ | No | Excellent |
| 7 | frost-giants | Frost Giants & Sunbeam Fairies | Swiss | Griffis | 3+ | No | Excellent |
| 8 | cuckoo-clock-fairy | Fairy in the Cuckoo Clock | Swiss | Griffis | 3+ | No | Excellent |
| 9 | edelweiss-fairy | Fairy of the Edelweiss | Swiss | Griffis | 3+ | No | Excellent |
| 10 | alpine-horn | Wonderful Alpine Horn | Swiss | Griffis | 3+ | No | Excellent |
| 11 | dwarf-chocolate | Dwarf's Confectionery | Swiss | Griffis | 4+ | No | Excellent |
| 12 | palace-under-waves | Palace Under the Waves | Swiss | Griffis | 4+ | No | Excellent |
| 13 | friendly-dragons | Two Good-Natured Dragons | Swiss | Griffis | 3+ | No | Excellent |
| 14 | gargantua-matterhorn | Gargantua of Matterhorn | Swiss | Legend | 3+ | No | Excellent |
| 15 | cinderella | Cinderella | European | Perrault/Grimm | 3+ | Mild | Excellent |
| 16 | snow-white | Snow White | European | Grimm | 4+ | Yes | Excellent |
| 17 | sleeping-beauty | Sleeping Beauty | European | Perrault/Grimm | 4+ | Mild | Excellent |
| 18 | red-riding-hood | Little Red Riding Hood | European | Perrault/Grimm | 4+ | Yes | Excellent |
| 19 | hansel-gretel | Hansel and Gretel | European | Grimm | 5+ | Yes | Excellent |
| 20 | rapunzel | Rapunzel | European | Grimm | 4+ | Yes | Excellent |
| 21 | frog-prince | The Frog Prince | European | Grimm | 3+ | Mild | Good |
| 22 | beauty-beast | Beauty and the Beast | European | Villeneuve | 4+ | No | Excellent |
| 23 | rumpelstiltskin | Rumpelstiltskin | European | Grimm | 5+ | Yes | Good |
| 24 | little-mermaid | The Little Mermaid | European | Andersen | 5+ | Yes | Excellent |
| 25 | ugly-duckling | The Ugly Duckling | European | Andersen | 3+ | No | Excellent |
| 26 | thumbelina | Thumbelina | European | Andersen | 3+ | No | Excellent |
| 27 | snow-queen | The Snow Queen | European | Andersen | 5+ | Mild | Excellent |
| 28 | emperors-clothes | Emperor's New Clothes | European | Andersen | 3+ | No | Good |
| 29 | princess-pea | Princess and the Pea | European | Andersen | 3+ | No | Excellent |
| 30 | puss-in-boots | Puss in Boots | European | Perrault | 4+ | No | Excellent |
| 31 | goldilocks | Goldilocks & Three Bears | European | English | 3+ | No | Excellent |
| 32 | three-little-pigs | Three Little Pigs | European | English | 3+ | Mild | Excellent |
| 33 | jack-beanstalk | Jack and the Beanstalk | European | English | 4+ | Mild | Excellent |
| 34 | pinocchio | Pinocchio | European | Collodi | 4+ | Yes | Excellent |
| 35 | bremen-musicians | Bremen Town Musicians | European | Grimm | 3+ | No | Excellent |
| 36 | elves-shoemaker | Elves and the Shoemaker | European | Grimm | 3+ | No | Excellent |
| 37 | aladdin | Aladdin | World | Arabian Nights | 4+ | Mild | Excellent |
| 38 | momotaro | Momotaro (Peach Boy) | World | Japanese | 4+ | Mild | Excellent |
| 39 | monkey-king | The Monkey King | World | Chinese | 5+ | Mild | Excellent |
| 40 | mulan | Mulan | World | Chinese | 5+ | Mild | Excellent |
| 41 | anansi | Anansi the Spider | World | West African | 4+ | No | Good |
| 42 | tortoise-hare | Tortoise and the Hare | World | Aesop | 3+ | No | Excellent |
| 43 | ali-baba | Ali Baba & Forty Thieves | World | Arabian Nights | 6+ | Yes | Excellent |

**Total: 43 tales** — 14 Swiss, 22 European classics, 7 World tales

## Implementation Notes

- Swiss tales are the differentiator — no competitor has these
- European classics are "table stakes" — parents expect to see these
- World tales add diversity and cultural breadth
- The "softening needed" column maps directly to story guide instructions for the AI
- Tales marked 3+ are safe for all ages; 5+ and 6+ need age-gating or careful prompting
- Pre-fetched location photos only apply to Swiss tales (real landmarks exist)
- Wilhelm Tell is already in historical — could be cross-listed or kept there only
