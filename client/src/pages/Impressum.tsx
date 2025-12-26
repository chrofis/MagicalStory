import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const impressumContent = {
  en: {
    title: 'Legal Notice (Impressum)',
    lastUpdated: 'Last updated: January 2025',
    sections: [
      {
        title: 'Contact',
        content: `Roger Fischer
Ennetbaden, Switzerland

Email: info@magicalstory.ch`
      },
      {
        title: 'Disclaimer',
        content: `The content of this website has been compiled with the greatest possible care. However, we cannot guarantee the accuracy, completeness, or timeliness of the content. As a service provider, we are responsible for our own content on these pages in accordance with general laws. However, we are not obligated to monitor transmitted or stored third-party information or to investigate circumstances that indicate illegal activity.

Obligations to remove or block the use of information in accordance with general laws remain unaffected. However, liability in this regard is only possible from the time of knowledge of a specific legal violation. Upon becoming aware of corresponding legal violations, we will remove this content immediately.`
      },
      {
        title: 'Copyright',
        content: `The content and works on these pages created by the site operators are subject to Swiss copyright law. Duplication, processing, distribution, or any form of commercialization of such material beyond the scope of copyright law requires the prior written consent of its respective author or creator.`
      }
    ]
  },
  de: {
    title: 'Impressum',
    lastUpdated: 'Zuletzt aktualisiert: Januar 2025',
    sections: [
      {
        title: 'Kontakt',
        content: `Roger Fischer
Ennetbaden, Schweiz

E-Mail: info@magicalstory.ch`
      },
      {
        title: 'Haftungsausschluss',
        content: `Der Inhalt dieser Website wurde mit grösstmöglicher Sorgfalt erstellt. Wir übernehmen jedoch keine Gewähr für die Richtigkeit, Vollständigkeit und Aktualität der Inhalte. Als Diensteanbieter sind wir für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Wir sind jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.

Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei Bekanntwerden von entsprechenden Rechtsverletzungen werden wir diese Inhalte umgehend entfernen.`
      },
      {
        title: 'Urheberrecht',
        content: `Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen dem Schweizer Urheberrecht. Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung ausserhalb der Grenzen des Urheberrechtes bedürfen der schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers.`
      }
    ]
  },
  fr: {
    title: 'Mentions Légales',
    lastUpdated: 'Dernière mise à jour : Janvier 2025',
    sections: [
      {
        title: 'Contact',
        content: `Roger Fischer
Ennetbaden, Suisse

Email : info@magicalstory.ch`
      },
      {
        title: 'Clause de non-responsabilité',
        content: `Le contenu de ce site web a été compilé avec le plus grand soin possible. Cependant, nous ne pouvons garantir l'exactitude, l'exhaustivité ou l'actualité du contenu. En tant que prestataire de services, nous sommes responsables de notre propre contenu sur ces pages conformément aux lois générales. Toutefois, nous ne sommes pas tenus de surveiller les informations tierces transmises ou stockées ni de rechercher des circonstances indiquant une activité illégale.

Les obligations de supprimer ou de bloquer l'utilisation d'informations conformément aux lois générales restent inchangées. Cependant, la responsabilité à cet égard n'est possible qu'à partir du moment de la connaissance d'une violation légale spécifique. Dès que nous aurons connaissance de violations légales correspondantes, nous supprimerons immédiatement ce contenu.`
      },
      {
        title: 'Droits d\'auteur',
        content: `Le contenu et les œuvres de ces pages créés par les opérateurs du site sont soumis au droit d'auteur suisse. La reproduction, le traitement, la distribution ou toute forme de commercialisation de ce matériel au-delà du champ d'application du droit d'auteur nécessite le consentement écrit préalable de son auteur ou créateur respectif.`
      }
    ]
  }
};

export default function Impressum() {
  const { language } = useLanguage();
  const navigate = useNavigate();
  const content = impressumContent[language] || impressumContent.en;

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 max-w-4xl mx-auto px-4 py-8">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 mb-6"
        >
          <ArrowLeft size={20} />
          {language === 'de' ? 'Zurück' : language === 'fr' ? 'Retour' : 'Back'}
        </button>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">{content.title}</h1>
        <p className="text-gray-500 mb-8">{content.lastUpdated}</p>

        <div className="bg-white rounded-xl shadow-sm p-6 md:p-8 space-y-8">
          {content.sections.map((section, index) => (
            <section key={index}>
              <h2 className="text-xl font-semibold text-gray-800 mb-3">{section.title}</h2>
              <div className="text-gray-600 whitespace-pre-line">{section.content}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
