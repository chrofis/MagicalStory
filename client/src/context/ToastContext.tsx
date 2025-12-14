import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { Toast } from '../components/common/Toast';

interface ToastData {
  id: string;
  message: string;
  title?: string;
  variant?: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
  details?: string[];
}

interface ToastContextType {
  showToast: (toast: Omit<ToastData, 'id'>) => void;
  showSuccess: (message: string, title?: string, details?: string[]) => void;
  showError: (message: string, title?: string) => void;
  showInfo: (message: string, title?: string) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: Omit<ToastData, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const showSuccess = useCallback((message: string, title?: string, details?: string[]) => {
    showToast({ message, title, variant: 'success', duration: 10000, details });
  }, [showToast]);

  const showError = useCallback((message: string, title?: string) => {
    showToast({ message, title, variant: 'error', duration: 8000 });
  }, [showToast]);

  const showInfo = useCallback((message: string, title?: string) => {
    showToast({ message, title, variant: 'info', duration: 6000 });
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ showToast, showSuccess, showError, showInfo, removeToast }}>
      {children}
      {/* Toast Container - fixed position */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            id={toast.id}
            message={toast.message}
            title={toast.title}
            variant={toast.variant}
            duration={toast.duration}
            details={toast.details}
            onClose={removeToast}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export default ToastContext;
