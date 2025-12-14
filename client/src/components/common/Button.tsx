import { ButtonHTMLAttributes, ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  children?: ReactNode;
}

const variantClasses = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl',
  secondary: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200',
  outline: 'border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50',
  ghost: 'text-indigo-600 hover:bg-indigo-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

const sizeClasses = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg',
};

export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  loading = false,
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      className={`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${variantClasses[variant]}
        ${sizeClasses[size]}
        ${className}
      `}
      disabled={isDisabled}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
            fill="none"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : Icon && iconPosition === 'left' ? (
        <Icon size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />
      ) : null}
      {children}
      {!loading && Icon && iconPosition === 'right' && (
        <Icon size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />
      )}
    </button>
  );
}

export default Button;
