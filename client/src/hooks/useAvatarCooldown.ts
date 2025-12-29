import { useState, useEffect, useCallback } from 'react';

interface CooldownInfo {
  canRegenerate: boolean;
  waitSeconds: number;
  attempts: number;
}

/**
 * Get avatar regeneration cooldown info for a character
 * Cooldown schedule: First 2 attempts no delay, then progressive delays
 */
function getAvatarCooldown(characterId: number): CooldownInfo {
  const key = `avatar_regen_${characterId}`;
  const data = localStorage.getItem(key);
  const now = Date.now();

  if (!data) {
    return { canRegenerate: true, waitSeconds: 0, attempts: 0 };
  }

  try {
    const { attempts, lastAttempt } = JSON.parse(data);

    // Calculate required delay based on attempts
    let requiredDelay = 0;
    if (attempts >= 2 && attempts < 4) {
      requiredDelay = 30 * 1000; // 30 seconds
    } else if (attempts >= 4 && attempts < 6) {
      requiredDelay = 60 * 1000; // 1 minute
    } else if (attempts >= 6 && attempts < 8) {
      requiredDelay = 2 * 60 * 1000; // 2 minutes
    } else if (attempts >= 8 && attempts < 10) {
      requiredDelay = 5 * 60 * 1000; // 5 minutes
    } else if (attempts >= 10) {
      requiredDelay = 10 * 60 * 1000; // 10 minutes
    }

    const elapsed = now - lastAttempt;
    if (elapsed >= requiredDelay) {
      return { canRegenerate: true, waitSeconds: 0, attempts };
    }

    return { canRegenerate: false, waitSeconds: Math.ceil((requiredDelay - elapsed) / 1000), attempts };
  } catch {
    return { canRegenerate: true, waitSeconds: 0, attempts: 0 };
  }
}

/**
 * Record an avatar regeneration attempt
 */
function recordAvatarRegeneration(characterId: number): void {
  const key = `avatar_regen_${characterId}`;
  const data = localStorage.getItem(key);
  const now = Date.now();

  let attempts = 1;
  if (data) {
    try {
      const parsed = JSON.parse(data);
      attempts = (parsed.attempts || 0) + 1;
    } catch {
      // ignore
    }
  }

  localStorage.setItem(key, JSON.stringify({ attempts, lastAttempt: now }));
}

/**
 * Hook to manage avatar regeneration cooldowns
 * Implements progressive cooldown: first 2 free, then 30s, 1m, 2m, 5m, 10m
 */
export function useAvatarCooldown(characterId: number) {
  const [cooldownInfo, setCooldownInfo] = useState<CooldownInfo>(() => getAvatarCooldown(characterId));

  // Update cooldown timer every second when waiting
  useEffect(() => {
    if (cooldownInfo.waitSeconds > 0) {
      const timer = setInterval(() => {
        setCooldownInfo(getAvatarCooldown(characterId));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [cooldownInfo.waitSeconds, characterId]);

  // Record regeneration and update state
  const recordRegeneration = useCallback(() => {
    recordAvatarRegeneration(characterId);
    setCooldownInfo(getAvatarCooldown(characterId));
  }, [characterId]);

  return {
    ...cooldownInfo,
    recordRegeneration
  };
}

export type { CooldownInfo };
