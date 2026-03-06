import { LucideIcon } from 'lucide-react';

interface IconProps {
  icon: LucideIcon;
  size?: number;
  className?: string;
  onClick?: () => void;
}

export function Icon({ icon: IconComponent, size = 24, className = '', onClick }: IconProps) {
  return (
    <IconComponent
      size={size}
      className={className}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    />
  );
}

export default Icon;
