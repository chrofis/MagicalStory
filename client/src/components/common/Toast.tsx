import { useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

export interface ToastProps {
  id: string;
  message: string;
  title?: string;
  variant?: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
  onClose: (id: string) => void;
  details?: string[];
}

const variantConfig = {
  success: {
    bg: 'bg-green-600',
    border: 'border-green-700',
    icon: CheckCircle,
  },
  error: {
    bg: 'bg-red-600',
    border: 'border-red-700',
    icon: AlertCircle,
  },
  info: {
    bg: 'bg-blue-600',
    border: 'border-blue-700',
    icon: Info,
  },
  warning: {
    bg: 'bg-yellow-500',
    border: 'border-yellow-600',
    icon: AlertTriangle,
  },
};

export function Toast({
  id,
  message,
  title,
  variant = 'info',
  duration = 8000,
  onClose,
  details,
}: ToastProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const config = variantConfig[variant];
  const IconComponent = config.icon;

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setIsVisible(true));

    // Auto-dismiss after duration
    if (duration > 0) {
      const timer = setTimeout(() => {
        handleClose();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration]);

  const handleClose = () => {
    setIsLeaving(true);
    setTimeout(() => onClose(id), 300);
  };

  return (
    <div
      className={`
        transform transition-all duration-300 ease-out
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
        ${config.bg} ${config.border}
        text-white rounded-lg shadow-2xl border
        max-w-md w-full pointer-events-auto
        overflow-hidden
      `}
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <IconComponent className="shrink-0 mt-0.5" size={24} />
          <div className="flex-1 min-w-0">
            {title && (
              <p className="font-bold text-lg mb-1">{title}</p>
            )}
            <p className="text-sm opacity-95">{message}</p>
            {details && details.length > 0 && (
              <div className="mt-3 pt-3 border-t border-white/20 space-y-1">
                {details.map((detail, idx) => (
                  <p key={idx} className="text-xs opacity-80">{detail}</p>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 p-1 rounded hover:bg-white/20 transition-colors"
            aria-label="Dismiss"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      {/* Progress bar for auto-dismiss */}
      {duration > 0 && (
        <div className="h-1 bg-white/20">
          <div
            className="h-full bg-white/40 transition-all ease-linear"
            style={{
              width: '100%',
              animation: `shrink ${duration}ms linear forwards`,
            }}
          />
        </div>
      )}
      <style>{`
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
}

export default Toast;
