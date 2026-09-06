import { useState, useEffect } from 'react';

interface RotatingMessages {
  de: string[];
  fr: string[];
  it: string[];
  en: string[];
}

const THINKING_MESSAGES: RotatingMessages = {
  de: [
    'Deine Geschichte entsteht...',
    'Ideen werden gesammelt...',
    'Ein Abenteuer braut sich zusammen...',
  ],
  fr: [
    'Ton histoire prend forme...',
    'Les idées se rassemblent...',
    'L\'aventure se tisse...',
  ],
  it: [
    'La tua storia prende forma...',
    'Raccogliamo le idee...',
    'Si prepara un\'avventura...',
  ],
  en: [
    'Your story is taking shape...',
    'Gathering ideas...',
    'Spinning an adventure...',
  ],
};

/**
 * Hook that rotates through creative messages every `intervalMs` milliseconds.
 * Used for progress indicators during story idea generation.
 */
export function useRotatingMessage(
  language: string,
  intervalMs: number = 5000
): string {
  const [messageIndex, setMessageIndex] = useState(0);

  // Determine language key (default to 'en' if not found)
  const langKey = language.startsWith('de') ? 'de'
    : language.startsWith('fr') ? 'fr'
    : language.startsWith('it') ? 'it'
    : 'en';

  const messages = THINKING_MESSAGES[langKey];

  useEffect(() => {
    const timer = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % messages.length);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [messages.length, intervalMs]);

  return messages[messageIndex];
}
