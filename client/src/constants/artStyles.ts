import type { ArtStyle } from '@/types/story';

export const artStyles: ArtStyle[] = [
  {
    id: 'pixar',
    name: { en: 'Pixar 3D', de: 'Pixar 3D', fr: 'Pixar 3D' },
    emoji: '🎬',
    image: '/images/Pixar style.jpg',
    description: {
      en: 'Vibrant, warm Disney/Pixar style 3D animation',
      de: 'Lebendige, warme Disney/Pixar 3D-Animation',
      fr: 'Animation 3D Disney/Pixar vibrante et chaleureuse',
    },
    prompt: 'pixar style 3d character, vibrant Disney/Pixar 3D animation, warm lighting, child-friendly',
  },
  {
    id: 'cartoon',
    name: { en: 'Cartoon', de: 'Cartoon', fr: 'Dessin animé' },
    emoji: '🎨',
    image: '/images/cartoon style.jpg',
    description: {
      en: 'Classic 2D cartoon style with bold colors',
      de: 'Klassischer 2D-Cartoon-Stil mit kräftigen Farben',
      fr: 'Style cartoon 2D classique aux couleurs vives',
    },
    prompt: '2D cartoon style, bold outlines, vibrant flat colors, classic animation look',
  },
  {
    id: 'anime',
    name: { en: 'Anime', de: 'Anime', fr: 'Anime' },
    emoji: '⭐',
    image: '/images/anime style.jpg',
    description: {
      en: 'Japanese anime style with expressive features',
      de: 'Japanischer Anime-Stil mit ausdrucksstarken Features',
      fr: 'Style anime japonais aux traits expressifs',
    },
    prompt: 'anime style, Japanese animation, expressive eyes, dynamic poses, cel-shaded',
  },
  {
    id: 'chibi',
    name: { en: 'Chibi', de: 'Chibi', fr: 'Chibi' },
    emoji: '🌸',
    image: '/images/chibi style.jpg',
    description: {
      en: 'Cute chibi style with big heads and small bodies',
      de: 'Niedlicher Chibi-Stil mit grossen Köpfen und kleinen Körpern',
      fr: 'Style chibi mignon avec grandes têtes et petits corps',
    },
    prompt: 'chibi style, super deformed, cute, big head, small body, kawaii, adorable',
  },
  {
    id: 'steampunk',
    name: { en: 'Steampunk', de: 'Steampunk', fr: 'Steampunk' },
    emoji: '⚙️',
    image: '/images/steampunk style.jpg',
    description: {
      en: 'Victorian-era inspired with gears and brass',
      de: 'Von der viktorianischen Ära inspiriert mit Zahnrädern und Messing',
      fr: "Inspiré de l'ère victorienne avec engrenages et laiton",
    },
    prompt: 'steampunk anime style, Victorian era, gears, brass, copper, goggles, mechanical details, vintage technology, anime influenced',
  },
  {
    id: 'comic',
    name: { en: 'Comic Book', de: 'Comic', fr: 'Bande dessinée' },
    emoji: '💥',
    image: '/images/comic book style.jpg',
    description: {
      en: 'Comic book style with bold lines and halftone',
      de: 'Comic-Stil mit kräftigen Linien und Raster',
      fr: 'Style bande dessinée avec lignes épaisses et trames',
    },
    prompt: 'comic book style, bold ink lines, halftone dots, dynamic action, speech bubbles aesthetic, superhero comic art',
  },
  {
    id: 'manga',
    name: { en: 'Manga', de: 'Manga', fr: 'Manga' },
    emoji: '📚',
    image: '/images/manga style.jpg',
    description: {
      en: 'Japanese manga style, black and white with screentones',
      de: 'Japanischer Manga-Stil, schwarz-weiss mit Rastern',
      fr: 'Style manga japonais, noir et blanc avec trames',
    },
    prompt: 'manga style, Japanese comic art, detailed linework, screentones, dramatic shading, expressive characters',
  },
  {
    id: 'watercolor',
    name: { en: 'Watercolor', de: 'Aquarell', fr: 'Aquarelle' },
    emoji: '🎨',
    image: '/images/water color style.jpg',
    description: {
      en: 'Soft watercolor painting with flowing colors',
      de: 'Sanfte Aquarellmalerei mit fliessenden Farben',
      fr: 'Peinture aquarelle douce aux couleurs fluides',
    },
    prompt: 'watercolor painting style, soft edges, flowing colors, delicate washes, artistic brushstrokes, dreamy atmosphere, traditional watercolor illustration',
  },
];
