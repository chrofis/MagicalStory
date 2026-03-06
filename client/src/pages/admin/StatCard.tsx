/**
 * StatCard - Statistics display card for Admin Dashboard
 */

interface StatCardProps {
  icon: React.ReactNode;
  title: string;
  value: number | string;
  isString?: boolean;
}

export function StatCard({ icon, title, value, isString = false }: StatCardProps) {
  return (
    <div className="bg-white rounded-2xl shadow-lg p-6 flex items-center gap-4">
      <div className="p-3 bg-gray-100 rounded-lg">{icon}</div>
      <div>
        <p className="text-sm text-gray-600">{title}</p>
        <p className="text-2xl font-bold text-gray-800">
          {isString ? value : (typeof value === 'number' ? value.toLocaleString() : value)}
        </p>
      </div>
    </div>
  );
}
