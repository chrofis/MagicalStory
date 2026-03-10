import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { Mail, Clock, HelpCircle, MessageCircle, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';

const contactContent: Record<string, {
  title: string;
  subtitle: string;
  emailTitle: string;
  emailText: string;
  emailAddress: string;
  responseTitle: string;
  responseText: string;
  faqTitle: string;
  faqText: string;
  faqButton: string;
  trialTitle: string;
  trialText: string;
  trialButton: string;
}> = {
  en: {
    title: 'Get in touch',
    subtitle: 'Have a question or need help? We\'re happy to assist.',
    emailTitle: 'Email us',
    emailText: 'Send us a message and we\'ll get back to you as soon as possible.',
    emailAddress: 'info@magicalstory.ch',
    responseTitle: 'Response time',
    responseText: 'We typically reply within 24 hours, Monday to Friday.',
    faqTitle: 'Check the FAQ first',
    faqText: 'Many common questions are already answered. You might find your answer faster there.',
    faqButton: 'Browse FAQ',
    trialTitle: 'Not sure yet?',
    trialText: 'Try it for free — your first story takes under 3 minutes, no account needed.',
    trialButton: 'Create a Free Story',
  },
  de: {
    title: 'Kontakt',
    subtitle: 'Hast du eine Frage oder brauchst Hilfe? Wir helfen dir gerne.',
    emailTitle: 'Schreib uns',
    emailText: 'Sende uns eine Nachricht und wir melden uns so bald wie möglich.',
    emailAddress: 'info@magicalstory.ch',
    responseTitle: 'Antwortzeit',
    responseText: 'Wir antworten in der Regel innerhalb von 24 Stunden, Montag bis Freitag.',
    faqTitle: 'Zuerst in die FAQ schauen',
    faqText: 'Viele Fragen sind dort bereits beantwortet. Vielleicht findest du schneller eine Antwort.',
    faqButton: 'FAQ ansehen',
    trialTitle: 'Noch unsicher?',
    trialText: 'Probier es gratis aus — deine erste Geschichte in unter 3 Minuten, ohne Konto.',
    trialButton: 'Gratis Geschichte erstellen',
  },
  fr: {
    title: 'Contactez-nous',
    subtitle: 'Vous avez une question ou besoin d\'aide ? Nous sommes là pour vous.',
    emailTitle: 'Écrivez-nous',
    emailText: 'Envoyez-nous un message et nous vous répondrons dès que possible.',
    emailAddress: 'info@magicalstory.ch',
    responseTitle: 'Temps de réponse',
    responseText: 'Nous répondons généralement dans les 24 heures, du lundi au vendredi.',
    faqTitle: 'Consultez d\'abord la FAQ',
    faqText: 'De nombreuses questions courantes y trouvent déjà réponse. Vous y trouverez peut-être plus vite.',
    faqButton: 'Voir la FAQ',
    trialTitle: 'Pas encore sûr ?',
    trialText: 'Essayez gratuitement — votre première histoire en moins de 3 minutes, sans compte.',
    trialButton: 'Créer une histoire gratuite',
  },
};

export default function Contact() {
  const { language } = useLanguage();
  const content = contactContent[language] || contactContent.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Header */}
      <div className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <MessageCircle className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-3">{content.title}</h1>
          <p className="text-gray-500 text-lg max-w-xl mx-auto">{content.subtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-3xl mx-auto px-4 py-10 w-full">
        {/* Email + Response time */}
        <div className="grid gap-4 md:grid-cols-2 mb-6">
          {/* Email card */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <div className="bg-indigo-50 w-11 h-11 rounded-xl flex items-center justify-center mb-4">
              <Mail className="w-5 h-5 text-indigo-600" />
            </div>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">{content.emailTitle}</h2>
            <p className="text-gray-500 text-sm mb-4 leading-relaxed">{content.emailText}</p>
            <a
              href={`mailto:${content.emailAddress}`}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors"
            >
              <Mail size={16} />
              {content.emailAddress}
            </a>
          </div>

          {/* Response time card */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <div className="bg-emerald-50 w-11 h-11 rounded-xl flex items-center justify-center mb-4">
              <Clock className="w-5 h-5 text-emerald-600" />
            </div>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">{content.responseTitle}</h2>
            <p className="text-gray-500 text-sm leading-relaxed">{content.responseText}</p>
          </div>
        </div>

        {/* FAQ nudge */}
        <div className="bg-white rounded-2xl border border-gray-100 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
          <div className="bg-amber-50 w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0">
            <HelpCircle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800 mb-1">{content.faqTitle}</h3>
            <p className="text-gray-500 text-sm">{content.faqText}</p>
          </div>
          <Link
            to="/faq"
            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors whitespace-nowrap"
          >
            {content.faqButton}
          </Link>
        </div>

        {/* Trial CTA */}
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl p-8 text-center border border-indigo-100">
          <h3 className="text-xl font-semibold text-gray-800 mb-2">{content.trialTitle}</h3>
          <p className="text-gray-600 mb-5 max-w-md mx-auto">{content.trialText}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors"
          >
            <Sparkles size={18} />
            {content.trialButton}
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
