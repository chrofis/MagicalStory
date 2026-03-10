import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowLeft, Mail, HelpCircle } from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';

const contactContent: Record<string, {
  title: string;
  intro: string;
  emailTitle: string;
  emailText: string;
  emailAddress: string;
  responseTime: string;
  faqTitle: string;
  faqText: string;
  faqLink: string;
}> = {
  en: {
    title: 'Contact',
    intro: 'Have a question or need help? We\'re happy to assist.',
    emailTitle: 'Email Us',
    emailText: 'Send us an email and we\'ll get back to you.',
    emailAddress: 'info@magicalstory.ch',
    responseTime: 'We usually reply within 24 hours.',
    faqTitle: 'Check the FAQ',
    faqText: 'Many questions are already answered in our FAQ. You might find your answer there faster.',
    faqLink: 'Go to FAQ',
  },
  de: {
    title: 'Kontakt',
    intro: 'Hast du eine Frage oder brauchst Hilfe? Wir helfen dir gerne.',
    emailTitle: 'Schreib uns',
    emailText: 'Sende uns eine E-Mail und wir melden uns bei dir.',
    emailAddress: 'info@magicalstory.ch',
    responseTime: 'Wir antworten in der Regel innerhalb von 24 Stunden.',
    faqTitle: 'Schau in die FAQ',
    faqText: 'Viele Fragen sind bereits in unseren FAQ beantwortet. Dort findest du vielleicht schneller eine Antwort.',
    faqLink: 'Zu den FAQ',
  },
  fr: {
    title: 'Contact',
    intro: 'Vous avez une question ou besoin d\'aide ? Nous sommes là pour vous.',
    emailTitle: 'Écrivez-nous',
    emailText: 'Envoyez-nous un email et nous vous répondrons.',
    emailAddress: 'info@magicalstory.ch',
    responseTime: 'Nous répondons généralement dans les 24 heures.',
    faqTitle: 'Consultez la FAQ',
    faqText: 'Beaucoup de questions trouvent déjà leur réponse dans notre FAQ. Vous y trouverez peut-être votre réponse plus rapidement.',
    faqLink: 'Aller à la FAQ',
  },
};

export default function Contact() {
  const { language } = useLanguage();
  const navigate = useNavigate();
  const content = contactContent[language] || contactContent.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 max-w-3xl mx-auto px-4 py-8 w-full">
        <button
          onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/')}
          className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 mb-6"
        >
          <ArrowLeft size={20} />
          {language === 'de' ? 'Zurück' : language === 'fr' ? 'Retour' : 'Back'}
        </button>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">{content.title}</h1>
        <p className="text-gray-600 mb-8">{content.intro}</p>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Email card */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="bg-indigo-100 w-12 h-12 rounded-full flex items-center justify-center mb-4">
              <Mail className="w-6 h-6 text-indigo-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-800 mb-2">{content.emailTitle}</h2>
            <p className="text-gray-600 mb-4">{content.emailText}</p>
            <a
              href={`mailto:${content.emailAddress}`}
              className="text-indigo-600 font-medium hover:text-indigo-800 hover:underline"
            >
              {content.emailAddress}
            </a>
            <p className="text-gray-500 text-sm mt-2">{content.responseTime}</p>
          </div>

          {/* FAQ card */}
          <div className="bg-white rounded-2xl shadow-sm p-6">
            <div className="bg-amber-100 w-12 h-12 rounded-full flex items-center justify-center mb-4">
              <HelpCircle className="w-6 h-6 text-amber-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-800 mb-2">{content.faqTitle}</h2>
            <p className="text-gray-600 mb-4">{content.faqText}</p>
            <Link
              to="/faq"
              className="text-indigo-600 font-medium hover:text-indigo-800 hover:underline"
            >
              {content.faqLink} &rarr;
            </Link>
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
}
