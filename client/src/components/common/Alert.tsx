import { ReactNode } from 'react';
import { AlertCircle, CheckCircle, Info, AlertTriangle, X } from 'lucide-react';

interface AlertProps {
  children: ReactNode;
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  onClose?: () => void;
  className?: string;
}

const variantConfig = {
  info: {
    bg: 'bg-blue-50 border-blue-200',
    text: 'text-blue-800',
    icon: Info,
  },
  success: {
    bg: 'bg-green-50 border-green-200',
    text: 'text-green-800',
    icon: CheckCircle,
  },
  warning: {
    bg: 'bg-yellow-50 border-yellow-200',
    text: 'text-yellow-800',
    icon: AlertTriangle,
  },
  error: {
    bg: 'bg-red-50 border-red-200',
    text: 'text-red-800',
    icon: AlertCircle,
  },
};

export function Alert({
  children,
  variant = 'info',
  title,
  onClose,
  className = '',
}: AlertProps) {
  const config = variantConfig[variant];
  const IconComponent = config.icon;

  return (
    <div
      className={`
        flex gap-3 p-4 rounded-lg border
        ${config.bg} ${config.text}
        ${className}
      `}
      role="alert"
    >
      <IconComponent className="shrink-0 mt-0.5" size={20} />
      <div className="flex-1">
        {title && <p className="font-semibold mb-1">{title}</p>}
        <div className="text-sm">{children}</div>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          className="shrink-0 p-1 rounded hover:bg-black/10 transition-colors"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export default Alert;
