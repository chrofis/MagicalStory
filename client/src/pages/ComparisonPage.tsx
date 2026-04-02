import { useState, useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import {
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Minus,
  Trophy,
  Shield,
  ExternalLink,
  Star,
} from 'lucide-react';
import { comparisons } from '@/constants/comparisonData';
import type { ComparisonData, ComparisonFeature, ListicleEntry } from '@/constants/comparisonData';

const pageTexts: Record<string, {
  breadcrumbRoot: string;
  quickComparison: string;
  ourStrengths: string;
  theirStrengths: string;
  feature: string;
  magicalStory: string;
  detailedVerdict: string;
  faqTitle: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  ranking: string;
  price: string;
  highlights: string;
  visitSite: string;
  compareWith: string;
  biasNote: string;
}> = {
  en: {
    breadcrumbRoot: 'Comparisons',
    quickComparison: 'Quick Comparison',
    ourStrengths: 'Where MagicalStory Excels',
    theirStrengths: 'Where {competitor} Excels',
    feature: 'Feature',
    magicalStory: 'MagicalStory',
    detailedVerdict: 'Our Verdict',
    faqTitle: 'Frequently Asked Questions',
    ctaTitle: 'Try MagicalStory for Free',
    ctaSubtitle: 'Your first story is free — no credit card needed. See the quality for yourself.',
    ctaButton: 'Create Your Free Story',
    ranking: 'Our Ranking',
    price: 'Price',
    highlights: 'Key Features',
    visitSite: 'Visit site',
    compareWith: 'Compare with MagicalStory',
    biasNote: 'We\'re MagicalStory, so we\'re biased — but we\'ve tried to be honest about where each option excels.',
  },
  de: {
    breadcrumbRoot: 'Vergleiche',
    quickComparison: 'Schnellvergleich',
    ourStrengths: 'Wo MagicalStory punktet',
    theirStrengths: 'Wo {competitor} punktet',
    feature: 'Eigenschaft',
    magicalStory: 'MagicalStory',
    detailedVerdict: 'Unser Fazit',
    faqTitle: 'Häufig gestellte Fragen',
    ctaTitle: 'Teste MagicalStory gratis',
    ctaSubtitle: 'Deine erste Geschichte ist gratis — keine Kreditkarte nötig. Überzeuge dich selbst.',
    ctaButton: 'Gratis-Geschichte erstellen',
    ranking: 'Unser Ranking',
    price: 'Preis',
    highlights: 'Wichtige Funktionen',
    visitSite: 'Seite besuchen',
    compareWith: 'Mit MagicalStory vergleichen',
    biasNote: 'Wir sind MagicalStory und daher befangen — aber wir haben versucht, ehrlich zu sein.',
  },
  fr: {
    breadcrumbRoot: 'Comparaisons',
    quickComparison: 'Comparaison rapide',
    ourStrengths: 'Où MagicalStory excelle',
    theirStrengths: 'Où {competitor} excelle',
    feature: 'Caractéristique',
    magicalStory: 'MagicalStory',
    detailedVerdict: 'Notre verdict',
    faqTitle: 'Questions fréquentes',
    ctaTitle: 'Essayez MagicalStory gratuitement',
    ctaSubtitle: 'Votre première histoire est gratuite — aucune carte de crédit requise.',
    ctaButton: 'Créer votre histoire gratuite',
    ranking: 'Notre classement',
    price: 'Prix',
    highlights: 'Fonctionnalités clés',
    visitSite: 'Visiter le site',
    compareWith: 'Comparer avec MagicalStory',
    biasNote: 'Nous sommes MagicalStory, donc nous sommes biaisés — mais nous avons essayé d\'être honnêtes.',
  },
};

function WinnerIcon({ winner }: { winner: 'us' | 'them' | 'tie' }) {
  if (winner === 'us') return <Check size={16} className="text-emerald-600" />;
  if (winner === 'them') return <X size={16} className="text-rose-400" />;
  return <Minus size={16} className="text-stone-400" />;
}

function WinnerIconThem({ winner }: { winner: 'us' | 'them' | 'tie' }) {
  if (winner === 'them') return <Check size={16} className="text-emerald-600" />;
  if (winner === 'us') return <X size={16} className="text-rose-400" />;
  return <Minus size={16} className="text-stone-400" />;
}

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-stone-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-stone-50 transition-colors"
      >
        <span className="font-semibold text-stone-800 pr-4">{q}</span>
        <ChevronDown
          size={20}
          className={`text-stone-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="px-5 pb-5 text-stone-600 leading-relaxed border-t border-stone-100 pt-4">
          {a}
        </div>
      )}
    </div>
  );
}

function ComparisonTable({
  features,
  competitorName,
  language,
  t,
}: {
  features: ComparisonFeature[];
  competitorName: string;
  language: string;
  t: typeof pageTexts.en;
}) {
  const lang = language as 'en' | 'de' | 'fr';
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b-2 border-stone-200">
            <th className="text-left py-3 px-4 text-sm font-semibold text-stone-500 w-1/3">
              {t.feature}
            </th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-indigo-500 w-1/3">
              {t.magicalStory}
            </th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-stone-600 w-1/3">
              {competitorName}
            </th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature, i) => (
            <tr
              key={i}
              className={i % 2 === 0 ? 'bg-stone-50/50' : ''}
            >
              <td className="py-3 px-4 text-sm font-medium text-stone-700">
                {feature.label[lang] || feature.label.en}
              </td>
              <td className="py-3 px-4 text-sm text-stone-600">
                <div className="flex items-center gap-2">
                  <WinnerIcon winner={feature.winner} />
                  <span>{feature.us}</span>
                </div>
              </td>
              <td className="py-3 px-4 text-sm text-stone-600">
                <div className="flex items-center gap-2">
                  <WinnerIconThem winner={feature.winner} />
                  <span>{feature.them}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListicleCard({
  entry,
  rank,
  language,
  t,
}: {
  entry: ListicleEntry;
  rank: number;
  language: string;
  t: typeof pageTexts.en;
}) {
  const lang = language as 'en' | 'de' | 'fr';
  const isUs = entry.name === 'MagicalStory';

  return (
    <div
      className={`rounded-2xl border p-6 md:p-8 ${
        isUs
          ? 'border-indigo-200 bg-indigo-50/30 ring-1 ring-indigo-100'
          : 'border-stone-200 bg-white'
      }`}
    >
      <div className="flex items-start gap-4 mb-4">
        <div
          className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg ${
            rank === 1
              ? 'bg-amber-100 text-amber-700'
              : rank === 2
              ? 'bg-stone-200 text-stone-600'
              : rank === 3
              ? 'bg-orange-100 text-orange-700'
              : 'bg-stone-100 text-stone-500'
          }`}
        >
          {rank}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xl font-bold text-stone-900">{entry.name}</h3>
            {isUs && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
                <Star size={12} /> Our pick
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-indigo-500 mt-0.5">
            {entry.bestFor[lang] || entry.bestFor.en}
          </p>
        </div>
      </div>

      <p className="text-stone-600 mb-4 italic">
        &ldquo;{entry.highlight[lang] || entry.highlight.en}&rdquo;
      </p>

      <div className="mb-4">
        <span className="text-sm font-medium text-stone-500">{t.price}: </span>
        <span className="text-sm text-stone-700">{entry.price[lang] || entry.price.en}</span>
      </div>

      <div className="mb-4">
        <span className="text-sm font-medium text-stone-500 block mb-2">{t.highlights}:</span>
        <div className="flex flex-wrap gap-2">
          {(entry.features[lang] || entry.features.en).map((feat, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-stone-100 text-stone-600 text-xs"
            >
              <Check size={12} className="text-emerald-500" />
              {feat}
            </span>
          ))}
        </div>
      </div>

      {entry.url && (
        <div className="flex items-center gap-4 pt-2">
          {isUs ? (
            <Link
              to="/try"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-500 hover:text-indigo-700"
            >
              {t.ctaButton} <ArrowRight size={14} />
            </Link>
          ) : (
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700"
            >
              {t.visitSite} <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function ComparisonPageContent({ data }: { data: ComparisonData }) {
  const { language } = useLanguage();
  const t = pageTexts[language] || pageTexts.en;
  const lang = language as 'en' | 'de' | 'fr';

  const title = data.title[lang] || data.title.en;
  const intro = data.intro[lang] || data.intro.en;
  const verdict = data.verdict[lang] || data.verdict.en;

  if (data.isListicle) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col">
        <Navigation currentStep={0} />

        {/* Breadcrumb */}
        <div className="bg-white border-b border-stone-100">
          <div className="max-w-4xl mx-auto px-4 pt-4 pb-0">
            <nav className="flex items-center gap-1.5 text-sm text-stone-500">
              <Link to="/vergleich" className="hover:text-indigo-500 transition-colors">
                {t.breadcrumbRoot}
              </Link>
              <ChevronRight size={14} className="text-stone-300" />
              <span className="text-stone-800 font-medium">{title}</span>
            </nav>
          </div>
        </div>

        {/* Hero */}
        <div className="bg-white border-b border-stone-100">
          <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-50 mb-5">
              <Trophy size={28} className="text-amber-600" />
            </div>
            <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-4">
              {title}
            </h1>
            <p className="text-stone-500 text-lg max-w-xl mx-auto mb-4">{intro}</p>
            <p className="text-sm text-stone-400 italic">{t.biasNote}</p>
          </div>
        </div>

        <div className="flex-1 max-w-4xl mx-auto px-4 py-10 w-full">
          {/* Listicle entries */}
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-6 text-center">
              {t.ranking}
            </h2>
            <div className="space-y-4">
              {(data.listicleEntries || []).map((entry, i) => (
                <ListicleCard
                  key={entry.name}
                  entry={entry}
                  rank={i + 1}
                  language={language}
                  t={t}
                />
              ))}
            </div>
          </div>

          {/* Verdict */}
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
              {t.detailedVerdict}
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6 md:p-8">
              <p className="text-stone-600 leading-relaxed">{verdict}</p>
            </div>
          </div>

          {/* FAQ */}
          {data.faq.length > 0 && (
            <div className="mb-12">
              <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
                {t.faqTitle}
              </h2>
              <div className="space-y-3">
                {data.faq.map((item, i) => (
                  <FAQItem
                    key={i}
                    q={item.q[lang] || item.q.en}
                    a={item.a[lang] || item.a.en}
                  />
                ))}
              </div>
            </div>
          )}

          {/* CTA */}
          <div className="bg-indigo-500 rounded-2xl p-8 md:p-12 text-center text-white">
            <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
            <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
            <Link
              to="/try"
              className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-500 font-semibold hover:bg-indigo-50 transition-colors"
            >
              {t.ctaButton} <ArrowRight size={18} />
            </Link>
          </div>
        </div>

        <Footer />
      </div>
    );
  }

  // ─── 1v1 Comparison Layout ──────────────────────────────────────
  const ourStrengths = data.ourStrengths[lang] || data.ourStrengths.en;
  const theirStrengths = data.theirStrengths[lang] || data.theirStrengths.en;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Breadcrumb */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-4 pb-0">
          <nav className="flex items-center gap-1.5 text-sm text-stone-500">
            <Link to="/vergleich" className="hover:text-indigo-500 transition-colors">
              {t.breadcrumbRoot}
            </Link>
            <ChevronRight size={14} className="text-stone-300" />
            <span className="text-stone-800 font-medium">{title}</span>
          </nav>
        </div>
      </div>

      {/* Hero */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-indigo-50 mb-5">
            <Shield size={28} className="text-indigo-500" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-4">
            {title}
          </h1>
          <p className="text-stone-500 text-lg max-w-xl mx-auto">{intro}</p>
        </div>
      </div>

      <div className="flex-1 max-w-4xl mx-auto px-4 py-10 w-full">
        {/* Quick Comparison Table */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
            {t.quickComparison}
          </h2>
          <div className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
            <ComparisonTable
              features={data.features}
              competitorName={data.competitorName}
              language={language}
              t={t}
            />
          </div>
        </div>

        {/* Our Strengths */}
        {ourStrengths.length > 0 && (
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
              {t.ourStrengths}
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6">
              <div className="space-y-3">
                {ourStrengths.map((s, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-50 flex items-center justify-center mt-0.5">
                      <Check size={14} className="text-emerald-600" />
                    </div>
                    <span className="text-stone-700">{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Their Strengths */}
        {theirStrengths.length > 0 && (
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
              {t.theirStrengths.replace('{competitor}', data.competitorName)}
            </h2>
            <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6">
              <div className="space-y-3">
                {theirStrengths.map((s, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-50 flex items-center justify-center mt-0.5">
                      <Check size={14} className="text-blue-600" />
                    </div>
                    <span className="text-stone-700">{s}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Verdict */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
            {t.detailedVerdict}
          </h2>
          <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6 md:p-8">
            <p className="text-stone-600 leading-relaxed">{verdict}</p>
            {data.competitorUrl && (
              <div className="mt-4 pt-4 border-t border-stone-100">
                <a
                  href={data.competitorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700"
                >
                  {t.visitSite}: {data.competitorName} <ExternalLink size={12} />
                </a>
              </div>
            )}
          </div>
        </div>

        {/* FAQ */}
        {data.faq.length > 0 && (
          <div className="mb-12">
            <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
              {t.faqTitle}
            </h2>
            <div className="space-y-3">
              {data.faq.map((item, i) => (
                <FAQItem
                  key={i}
                  q={item.q[lang] || item.q.en}
                  a={item.a[lang] || item.a.en}
                />
              ))}
            </div>
          </div>
        )}

        {/* CTA */}
        <div className="bg-indigo-500 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-500 font-semibold hover:bg-indigo-50 transition-colors"
          >
            {t.ctaButton} <ArrowRight size={18} />
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}

export default function ComparisonPage() {
  const { competitorSlug } = useParams<{ competitorSlug: string }>();

  const data = useMemo(() => {
    if (!competitorSlug) return null;
    return comparisons.find((c) => c.id === competitorSlug) || null;
  }, [competitorSlug]);

  if (!data) {
    return <Navigate to="/vergleich" replace />;
  }

  return <ComparisonPageContent data={data} />;
}
