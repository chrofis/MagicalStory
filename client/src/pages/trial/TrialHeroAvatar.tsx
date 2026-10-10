import { reportImageFrame } from '@/utils/frameDiagnostics';
/**
 * The hero's full-body picture on the character and topic steps. A fixed frame (about the 1:2 of a body cell) with the
 * image filling it and object-contain: the picture is never taller than its frame and never cropped, whatever the
 * browser makes of an in-flow image with max-height (iPhone WebKit sized such images from their natural height).
 */
export default function TrialHeroAvatar({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  return (
    <div data-testid="trial-hero-avatar" className={`relative w-28 h-56 rounded-xl overflow-hidden shadow-lg ${className}`}>
      <img src={src} alt={alt} className="absolute inset-0 w-full h-full object-contain" onLoad={(e) => reportImageFrame(e.currentTarget, 'hero')} />
    </div>
  );
}
