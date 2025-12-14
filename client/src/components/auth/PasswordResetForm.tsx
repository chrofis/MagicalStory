import { useState, FormEvent } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Alert } from '@/components/common/Alert';

interface PasswordResetFormProps {
  onSubmit: (email: string) => Promise<void>;
  onBack: () => void;
  error?: string;
  isLoading?: boolean;
}

export function PasswordResetForm({
  onSubmit,
  onBack,
  error,
  isLoading,
}: PasswordResetFormProps) {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await onSubmit(email);
  };

  return (
    <>
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">{t.resetPassword}</h2>
        <p className="text-gray-500">{t.resetPasswordDesc}</p>
      </div>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          type="email"
          label={t.email}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          disabled={isLoading}
        />

        <Button
          type="submit"
          variant="primary"
          loading={isLoading}
          className="w-full"
        >
          {t.sendResetLink}
        </Button>
      </form>

      <div className="mt-4 text-center">
        <button
          onClick={onBack}
          className="text-indigo-600 font-semibold hover:text-gray-800"
        >
          {t.backToLogin}
        </button>
      </div>
    </>
  );
}

export default PasswordResetForm;
