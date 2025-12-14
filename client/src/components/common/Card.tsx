import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
  selected?: boolean;
}

export function Card({
  children,
  className = '',
  onClick,
  hoverable = false,
  selected = false,
}: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`
        bg-white rounded-2xl shadow-lg p-6
        ${hoverable ? 'hover:shadow-xl hover:scale-[1.02] transition-all duration-200 cursor-pointer' : ''}
        ${selected ? 'ring-2 ring-purple-500 bg-purple-50' : ''}
        ${className}
      `}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '' }: CardHeaderProps) {
  return (
    <div className={`mb-4 ${className}`}>
      {children}
    </div>
  );
}

interface CardTitleProps {
  children: ReactNode;
  className?: string;
}

export function CardTitle({ children, className = '' }: CardTitleProps) {
  return (
    <h3 className={`text-xl font-bold text-gray-800 ${className}`}>
      {children}
    </h3>
  );
}

interface CardContentProps {
  children: ReactNode;
  className?: string;
}

export function CardContent({ children, className = '' }: CardContentProps) {
  return <div className={className}>{children}</div>;
}

export default Card;
