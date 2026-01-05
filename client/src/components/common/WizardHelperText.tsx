import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface WizardHelperTextProps {
  step: number;
  text: string;
}

/**
 * Dismissible helper text for wizard steps.
 * Shows helpful guidance for first-time users.
 * Remembers dismissal per step in localStorage.
 */
export function WizardHelperText({ step, text }: WizardHelperTextProps) {
  const storageKey = `wizard_helper_dismissed_${step}`;
  const [isDismissed, setIsDismissed] = useState(() => {
    return localStorage.getItem(storageKey) === 'true';
  });

  // Reset if step changes and check storage
  useEffect(() => {
    const dismissed = localStorage.getItem(storageKey) === 'true';
    setIsDismissed(dismissed);
  }, [step, storageKey]);

  const handleDismiss = () => {
    localStorage.setItem(storageKey, 'true');
    setIsDismissed(true);
  };

  if (isDismissed) {
    return null;
  }

  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 md:px-4 md:py-3 mb-4 flex items-start gap-2 md:gap-3">
      <p className="text-sm text-indigo-700 flex-1">
        {text}
      </p>
      <button
        onClick={handleDismiss}
        className="text-indigo-400 hover:text-indigo-600 transition-colors flex-shrink-0 p-0.5"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export default WizardHelperText;
