import { useEffect, useCallback, useState, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface ImageLightboxProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

/**
 * Full-screen lightbox with mouse wheel zoom and pan support
 * - Scroll to zoom in/out
 * - Click and drag to pan when zoomed
 * - Double-click to reset zoom
 * - Press Escape or click background to close
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 5;
  const ZOOM_STEP = 0.2;

  const resetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  // Reset zoom when image changes
  useEffect(() => {
    if (src) {
      resetZoom();
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [src, handleEscape, resetZoom]);

  // Handle mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setScale(prev => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta)));
  }, []);

  // Handle drag start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale > 1) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  }, [scale, position]);

  // Handle drag move
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  }, [isDragging, dragStart, scale]);

  // Handle drag end
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle double-click to reset
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    resetZoom();
  }, [resetZoom]);

  // Handle background click (only close if not zoomed or clicking outside image area)
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current && scale === 1) {
      onClose();
    }
  }, [onClose, scale]);

  const zoomIn = useCallback(() => {
    setScale(prev => Math.min(MAX_SCALE, prev + ZOOM_STEP * 2));
  }, []);

  const zoomOut = useCallback(() => {
    setScale(prev => Math.max(MIN_SCALE, prev - ZOOM_STEP * 2));
  }, []);

  if (!src) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={handleBackgroundClick}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Control buttons */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          onClick={zoomOut}
          className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
          aria-label="Zoom out"
          title="Zoom out"
        >
          <ZoomOut size={20} />
        </button>
        <span className="px-2 py-1 rounded bg-black/50 text-white text-sm min-w-[60px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={zoomIn}
          className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
          aria-label="Zoom in"
          title="Zoom in"
        >
          <ZoomIn size={20} />
        </button>
        <button
          onClick={resetZoom}
          className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
          aria-label="Reset zoom"
          title="Reset zoom (or double-click)"
        >
          <RotateCcw size={20} />
        </button>
        <button
          onClick={onClose}
          className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors ml-2"
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={24} />
        </button>
      </div>

      {/* Zoom hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/50 text-white/70 text-xs z-10">
        Scroll to zoom • Drag to pan • Double-click to reset
      </div>

      {/* Image container */}
      <div
        className="w-full h-full flex items-center justify-center overflow-hidden"
        onWheel={handleWheel}
      >
        <img
          src={src}
          alt={alt || 'Enlarged image'}
          className="max-w-[98vw] max-h-[96vh] object-contain rounded-lg shadow-2xl select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
            transition: isDragging ? 'none' : 'transform 0.1s ease-out'
          }}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          draggable={false}
        />
      </div>
    </div>
  );
}

export default ImageLightbox;
