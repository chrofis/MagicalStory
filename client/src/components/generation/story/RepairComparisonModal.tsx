import { X } from 'lucide-react';

interface RepairComparisonModalProps {
  beforeImage: string;
  afterImage: string;
  diffImage?: string;
  title: string;
  onClose: () => void;
}

export function RepairComparisonModal({
  beforeImage,
  afterImage,
  diffImage,
  title,
  onClose,
}: RepairComparisonModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="relative bg-white rounded-lg overflow-hidden max-w-[95vw] max-h-[95vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-gray-100 px-4 py-3 flex items-center justify-between border-b">
          <h3 className="font-semibold text-gray-800">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 p-1"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-4 bg-gray-50 overflow-auto max-h-[calc(95vh-60px)]">
          <div className={`grid gap-4 ${diffImage ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'}`}>
            {/* Before */}
            <div className="flex flex-col items-center">
              <span className="text-sm font-semibold text-gray-700 mb-2 bg-red-100 px-3 py-1 rounded-full">
                Before
              </span>
              <img
                src={beforeImage}
                alt="Before repair"
                className="max-w-full max-h-[70vh] object-contain border rounded shadow-sm"
              />
            </div>

            {/* After */}
            <div className="flex flex-col items-center">
              <span className="text-sm font-semibold text-gray-700 mb-2 bg-green-100 px-3 py-1 rounded-full">
                After
              </span>
              <img
                src={afterImage}
                alt="After repair"
                className="max-w-full max-h-[70vh] object-contain border rounded shadow-sm"
              />
            </div>

            {/* Diff */}
            {diffImage && (
              <div className="flex flex-col items-center">
                <span className="text-sm font-semibold text-gray-700 mb-2 bg-purple-100 px-3 py-1 rounded-full">
                  Diff (changes in magenta)
                </span>
                <img
                  src={diffImage}
                  alt="Difference"
                  className="max-w-full max-h-[70vh] object-contain border rounded shadow-sm"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
