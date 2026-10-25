import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useLangPath } from '@/hooks/useLangPath';
import { storyService } from '@/services';

const texts = {
  en: { text: 'You have a voucher book waiting.', cta: 'Order it now' },
  de: { text: 'Du hast ein Gutschein-Buch offen.', cta: 'Jetzt bestellen' },
  fr: { text: 'Un livre de bon cadeau vous attend.', cta: 'Le commander' },
  it: { text: 'Hai un libro del buono da ordinare.', cta: 'Ordinalo ora' },
};

/** Shown on the stories page while the user holds an unused voucher book. Renders nothing otherwise. */
export default function VoucherBookBanner() {
  const { language } = useLanguage();
  const lp = useLangPath();
  const t = texts[language as keyof typeof texts] || texts.en;
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Informational banner only: when the check fails there is simply nothing to show.
    storyService.getVoucherBookCredit()
      .then(c => { if (!cancelled) setAvailable(c.available); })
      .catch(() => { /* no banner */ });
    return () => { cancelled = true; };
  }, []);

  if (!available) return null;
  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 mb-4 flex items-center gap-3">
      <Gift size={20} className="text-indigo-600 flex-shrink-0" />
      <p className="text-indigo-800 text-sm">{t.text}</p>
      <Link to={lp('/gutschein/buch')} className="ml-auto text-sm font-medium text-indigo-600 hover:text-indigo-700 whitespace-nowrap">
        {t.cta} →
      </Link>
    </div>
  );
}
