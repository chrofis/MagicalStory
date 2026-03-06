import { X } from 'lucide-react';

interface EnlargedImageModalProps {
  src: string;
  title: string;
  onClose: () => void;
}

export function EnlargedImageModal({
  src,
  title,
  onClose,
}: EnlargedImageModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div className="relative max-w-4xl max-h-[90vh] bg-white rounded-lg overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="bg-gray-100 px-4 py-2 flex items-center justify-between border-b">
          <h3 className="font-semibold text-gray-800">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 p-1"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-4 bg-gray-50">
          <img
            src={src}
            alt={title}
            className="max-w-full max-h-[80vh] object-contain mx-auto"
          />
        </div>
      </div>
    </div>
  );
}
