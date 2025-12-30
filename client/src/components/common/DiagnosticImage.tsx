import { useState, useEffect, useRef } from 'react';
import { createLogger } from '@/services/logger';

const log = createLogger('ImageLoad');

interface DiagnosticImageProps {
  src: string;
  alt: string;
  className?: string;
  label?: string; // For identifying which image in logs
}

/**
 * Image component with diagnostic logging for load times
 * Helps debug slow image loading on mobile devices
 */
export function DiagnosticImage({ src, alt, className, label }: DiagnosticImageProps) {
  const [_isLoading, setIsLoading] = useState(true);
  const [_loadTime, setLoadTime] = useState<number | null>(null);
  // Don't start timer until we have actual image data
  const startTimeRef = useRef<number>(0);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // Only start/reset timer when we have actual image data (> 100 chars for base64)
    const hasActualData = src && src.length > 100;
    if (hasActualData) {
      // Always reset timer when new data arrives
      startTimeRef.current = Date.now();
      log.info(`⏳ Loading ${label || alt}`, {
        isBase64: src?.startsWith('data:'),
        sizeKB: Math.round((src.length * 3) / 4 / 1024),
      });
    } else {
      // No real data yet, keep timer at 0
      startTimeRef.current = 0;
    }
    setIsLoading(true);
    setLoadTime(null);
  }, [src, alt, label]);

  const handleLoad = () => {
    setIsLoading(false);

    // Don't report timing if timer was never started (no real data yet)
    if (startTimeRef.current === 0) {
      log.info(`✅ Loaded ${label || alt} (placeholder/empty)`);
      return;
    }

    const elapsed = Date.now() - startTimeRef.current;
    setLoadTime(elapsed);

    const isBase64 = src?.startsWith('data:');
    const sizeKB = isBase64 ? Math.round((src.length * 3) / 4 / 1024) : null;
    const naturalSize = imgRef.current
      ? `${imgRef.current.naturalWidth}x${imgRef.current.naturalHeight}`
      : 'unknown';

    // Log with color based on load time
    if (elapsed < 100) {
      log.success(`✅ Loaded ${label || alt} in ${elapsed}ms`, { sizeKB, naturalSize });
    } else if (elapsed < 500) {
      log.info(`✅ Loaded ${label || alt} in ${elapsed}ms`, { sizeKB, naturalSize });
    } else if (elapsed < 2000) {
      log.warn(`⚠️ Slow load: ${label || alt} took ${elapsed}ms`, { sizeKB, naturalSize });
    } else {
      log.error(`🐢 Very slow: ${label || alt} took ${elapsed}ms`, { sizeKB, naturalSize });
    }

    // Log to server for remote debugging (only for slow loads > 1s)
    if (elapsed > 1000) {
      logToServer({
        type: 'slow_image_load',
        label: label || alt,
        loadTimeMs: elapsed,
        sizeKB,
        naturalSize,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const handleError = () => {
    setIsLoading(false);
    if (startTimeRef.current === 0) {
      log.error(`❌ Failed to load ${label || alt} (no data received)`);
      return;
    }
    const elapsed = Date.now() - startTimeRef.current;
    log.error(`❌ Failed to load ${label || alt} after ${elapsed}ms`);
  };

  return (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      className={className}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}

// Log slow loads to server for remote debugging
async function logToServer(data: Record<string, unknown>) {
  try {
    await fetch('/api/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        errorType: 'Performance',
        message: `Slow image load: ${data.label} took ${data.loadTimeMs}ms`,
        userAgent: data.userAgent,
        timestamp: data.timestamp,
        url: window.location.href,
      }),
    });
  } catch {
    // Ignore logging errors
  }
}

export default DiagnosticImage;
