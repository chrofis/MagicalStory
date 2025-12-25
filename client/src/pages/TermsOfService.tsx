import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const termsContent = {
  en: {
    title: 'Terms of Service',
    lastUpdated: 'Last updated: January 2025',
    sections: [
      {
        title: '1. Acceptance of Terms',
        content: `By accessing and using Magical Story ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Service.`
      },
      {
        title: '2. Service Availability and Eligibility',
        content: `IMPORTANT: This Service is intended exclusively for residents of Switzerland and the European Union.

• This Service is NOT available to residents or citizens of the United States of America
• By using this Service, you warrant and represent that you are a resident of Switzerland or a member state of the European Union
• You confirm that you are accessing this Service from Switzerland or the European Union
• Any attempt to access this Service from the United States or by US residents is prohibited
• We reserve the right to terminate accounts and refuse service to anyone who misrepresents their residency or location`
      },
      {
        title: '3. Description of Service',
        content: `Magical Story is an AI-powered platform that creates personalized storybooks based on photos and character descriptions you provide. Photos are transformed into illustrated avatars that appear in your custom story.`
      },
      {
        title: '4. User Responsibilities and Warranties',
        content: `By using the Service, you warrant and represent that:

• You are a resident of Switzerland or the European Union (not the United States)
• You have the legal right to upload and use any photos you submit
• For photos of minors, you are the parent or legal guardian, or have obtained explicit permission from the parent/guardian
• You will not upload photos of individuals without their consent
• All information you provide is accurate and not misleading
• You will not use the Service for any unlawful purpose
• You will not upload content that is defamatory, obscene, or infringes on third-party rights`
      },
      {
        title: '5. Intellectual Property',
        content: `• You retain all rights to the original photos you upload
• You grant us a limited license to process your photos solely for the purpose of creating your personalized story
• The generated story content and illustrations become your property upon purchase
• Our platform, technology, and branding remain our intellectual property`
      },
      {
        title: '6. Content and Output Responsibility',
        content: `• AI-generated content may occasionally produce unexpected results
• You are responsible for reviewing the generated content before finalizing or sharing
• You assume full responsibility for any use of the generated stories
• We do not guarantee that AI-generated content will be free from errors or suitable for all purposes`
      },
      {
        title: '7. Limitation of Liability',
        content: `TO THE MAXIMUM EXTENT PERMITTED BY LAW:

• The Service is provided "as is" without warranties of any kind
• We are not liable for any indirect, incidental, special, or consequential damages
• Our total liability shall not exceed the amount you paid for the specific service giving rise to the claim
• We are not responsible for any claims arising from your misuse of the Service or violation of these terms`
      },
      {
        title: '8. Indemnification',
        content: `You agree to indemnify, defend, and hold harmless Magical Story, its officers, directors, employees, and agents from any claims, damages, losses, or expenses (including legal fees) arising from:

• Your use of the Service
• Your violation of these Terms
• Your violation of any third-party rights
• Content you upload or create using the Service`
      },
      {
        title: '9. Data Processing',
        content: `• Photos are processed using AI technology to create avatar illustrations
• Original photos are stored temporarily for processing and are deleted according to our Privacy Policy
• We do not sell or share your personal photos with third parties for marketing purposes
• See our Privacy Policy for complete details on data handling`
      },
      {
        title: '10. Age Requirements',
        content: `• You must be at least 18 years old to create an account
• Parents/guardians may create stories featuring their minor children
• By uploading photos of minors, you confirm you have parental authority or explicit consent`
      },
      {
        title: '11. Modifications to Terms',
        content: `We reserve the right to modify these Terms at any time. Continued use of the Service after changes constitutes acceptance of the new terms. We will notify users of significant changes via email or platform notification.`
      },
      {
        title: '12. Termination',
        content: `We may terminate or suspend your account at any time for violation of these Terms. Upon termination, your right to use the Service ceases immediately.`
      },
      {
        title: '13. Governing Law and Jurisdiction',
        content: `• These Terms are governed exclusively by the laws of Switzerland
• Any disputes arising from these Terms or your use of the Service shall be resolved exclusively in the courts of Zurich, Switzerland
• You agree to submit to the exclusive jurisdiction of the courts of Zurich, Switzerland
• The United Nations Convention on Contracts for the International Sale of Goods does not apply`
      },
      {
        title: '14. Contact',
        content: `For questions about these Terms, please contact us at: legal@magicalstory.com`
      }
    ]
  },
  de: {
    title: 'Nutzungsbedingungen',
    lastUpdated: 'Zuletzt aktualisiert: Januar 2025',
    sections: [
      {
        title: '1. Annahme der Bedingungen',
        content: `Durch den Zugriff auf und die Nutzung von Magical Story ("der Dienst") erklären Sie sich mit diesen Nutzungsbedingungen einverstanden. Wenn Sie diesen Bedingungen nicht zustimmen, nutzen Sie den Dienst bitte nicht.`
      },
      {
        title: '2. Dienstverfügbarkeit und Berechtigung',
        content: `WICHTIG: Dieser Dienst ist ausschließlich für Einwohner der Schweiz und der Europäischen Union bestimmt.

• Dieser Dienst ist NICHT für Einwohner oder Staatsbürger der Vereinigten Staaten von Amerika verfügbar
• Durch die Nutzung dieses Dienstes garantieren und versichern Sie, dass Sie Einwohner der Schweiz oder eines Mitgliedstaates der Europäischen Union sind
• Sie bestätigen, dass Sie von der Schweiz oder der Europäischen Union aus auf diesen Dienst zugreifen
• Jeder Versuch, von den Vereinigten Staaten aus oder als US-Einwohner auf diesen Dienst zuzugreifen, ist untersagt
• Wir behalten uns das Recht vor, Konten zu kündigen und Personen, die ihren Wohnsitz oder Standort falsch angeben, den Dienst zu verweigern`
      },
      {
        title: '3. Beschreibung des Dienstes',
        content: `Magical Story ist eine KI-gestützte Plattform, die personalisierte Geschichtenbücher basierend auf von Ihnen bereitgestellten Fotos und Charakterbeschreibungen erstellt. Fotos werden in illustrierte Avatare umgewandelt, die in Ihrer individuellen Geschichte erscheinen.`
      },
      {
        title: '4. Verantwortlichkeiten und Zusicherungen des Nutzers',
        content: `Durch die Nutzung des Dienstes garantieren und versichern Sie, dass:

• Sie Einwohner der Schweiz oder der Europäischen Union sind (nicht der Vereinigten Staaten)
• Sie das gesetzliche Recht haben, alle von Ihnen hochgeladenen Fotos zu verwenden
• Bei Fotos von Minderjährigen Sie der Elternteil oder gesetzliche Vormund sind oder die ausdrückliche Genehmigung des Elternteils/Vormunds eingeholt haben
• Sie keine Fotos von Personen ohne deren Zustimmung hochladen werden
• Alle von Ihnen bereitgestellten Informationen korrekt und nicht irreführend sind
• Sie den Dienst nicht für rechtswidrige Zwecke nutzen werden
• Sie keine Inhalte hochladen, die diffamierend, obszön sind oder Rechte Dritter verletzen`
      },
      {
        title: '5. Geistiges Eigentum',
        content: `• Sie behalten alle Rechte an den von Ihnen hochgeladenen Originalfotos
• Sie gewähren uns eine eingeschränkte Lizenz zur Verarbeitung Ihrer Fotos ausschließlich zum Zweck der Erstellung Ihrer personalisierten Geschichte
• Die generierten Geschichtsinhalte und Illustrationen werden nach dem Kauf Ihr Eigentum
• Unsere Plattform, Technologie und Marke bleiben unser geistiges Eigentum`
      },
      {
        title: '6. Inhalts- und Ergebnisverantwortung',
        content: `• KI-generierte Inhalte können gelegentlich unerwartete Ergebnisse liefern
• Sie sind dafür verantwortlich, die generierten Inhalte vor der Fertigstellung oder Weitergabe zu überprüfen
• Sie übernehmen die volle Verantwortung für jede Nutzung der generierten Geschichten
• Wir garantieren nicht, dass KI-generierte Inhalte fehlerfrei oder für alle Zwecke geeignet sind`
      },
      {
        title: '7. Haftungsbeschränkung',
        content: `IM GESETZLICH ZULÄSSIGEN RAHMEN:

• Der Dienst wird ohne jegliche Garantien bereitgestellt
• Wir haften nicht für indirekte, zufällige, besondere oder Folgeschäden
• Unsere Gesamthaftung übersteigt nicht den Betrag, den Sie für den spezifischen Dienst bezahlt haben
• Wir sind nicht verantwortlich für Ansprüche, die aus Ihrem Missbrauch des Dienstes oder Ihrer Verletzung dieser Bedingungen entstehen`
      },
      {
        title: '8. Freistellung',
        content: `Sie verpflichten sich, Magical Story, seine leitenden Angestellten, Direktoren, Mitarbeiter und Vertreter von allen Ansprüchen, Schäden, Verlusten oder Kosten (einschließlich Anwaltsgebühren) freizustellen, die entstehen aus:

• Ihrer Nutzung des Dienstes
• Ihrer Verletzung dieser Bedingungen
• Ihrer Verletzung von Rechten Dritter
• Inhalten, die Sie hochladen oder mit dem Dienst erstellen`
      },
      {
        title: '9. Datenverarbeitung',
        content: `• Fotos werden mit KI-Technologie verarbeitet, um Avatar-Illustrationen zu erstellen
• Originalfotos werden vorübergehend zur Verarbeitung gespeichert und gemäß unserer Datenschutzrichtlinie gelöscht
• Wir verkaufen oder teilen Ihre persönlichen Fotos nicht zu Marketingzwecken mit Dritten
• Siehe unsere Datenschutzrichtlinie für vollständige Details zur Datenverarbeitung`
      },
      {
        title: '10. Altersanforderungen',
        content: `• Sie müssen mindestens 18 Jahre alt sein, um ein Konto zu erstellen
• Eltern/Erziehungsberechtigte können Geschichten mit ihren minderjährigen Kindern erstellen
• Durch das Hochladen von Fotos von Minderjährigen bestätigen Sie, dass Sie elterliche Autorität oder ausdrückliche Zustimmung haben`
      },
      {
        title: '11. Änderungen der Bedingungen',
        content: `Wir behalten uns das Recht vor, diese Bedingungen jederzeit zu ändern. Die fortgesetzte Nutzung des Dienstes nach Änderungen gilt als Annahme der neuen Bedingungen. Wir werden Benutzer über wesentliche Änderungen per E-Mail oder Plattformbenachrichtigung informieren.`
      },
      {
        title: '12. Kündigung',
        content: `Wir können Ihr Konto jederzeit bei Verstoß gegen diese Bedingungen kündigen oder sperren. Bei Kündigung erlischt Ihr Recht zur Nutzung des Dienstes sofort.`
      },
      {
        title: '13. Anwendbares Recht und Gerichtsstand',
        content: `• Diese Bedingungen unterliegen ausschließlich dem Recht der Schweiz
• Alle Streitigkeiten aus diesen Bedingungen oder Ihrer Nutzung des Dienstes werden ausschließlich vor den Gerichten in Zürich, Schweiz, beigelegt
• Sie stimmen der ausschließlichen Zuständigkeit der Gerichte in Zürich, Schweiz, zu
• Das Übereinkommen der Vereinten Nationen über Verträge über den internationalen Warenkauf findet keine Anwendung`
      },
      {
        title: '14. Kontakt',
        content: `Bei Fragen zu diesen Bedingungen kontaktieren Sie uns bitte unter: legal@magicalstory.com`
      }
    ]
  },
  fr: {
    title: 'Conditions d\'Utilisation',
    lastUpdated: 'Dernière mise à jour : Janvier 2025',
    sections: [
      {
        title: '1. Acceptation des Conditions',
        content: `En accédant et en utilisant Magical Story ("le Service"), vous acceptez d'être lié par ces Conditions d'Utilisation. Si vous n'acceptez pas ces conditions, veuillez ne pas utiliser le Service.`
      },
      {
        title: '2. Disponibilité du Service et Éligibilité',
        content: `IMPORTANT : Ce Service est destiné exclusivement aux résidents de la Suisse et de l'Union Européenne.

• Ce Service n'est PAS disponible pour les résidents ou citoyens des États-Unis d'Amérique
• En utilisant ce Service, vous garantissez et déclarez que vous êtes résident de la Suisse ou d'un État membre de l'Union Européenne
• Vous confirmez que vous accédez à ce Service depuis la Suisse ou l'Union Européenne
• Toute tentative d'accéder à ce Service depuis les États-Unis ou par des résidents américains est interdite
• Nous nous réservons le droit de résilier les comptes et de refuser le service à toute personne qui falsifie sa résidence ou son emplacement`
      },
      {
        title: '3. Description du Service',
        content: `Magical Story est une plateforme alimentée par l'IA qui crée des livres d'histoires personnalisés basés sur les photos et descriptions de personnages que vous fournissez. Les photos sont transformées en avatars illustrés qui apparaissent dans votre histoire personnalisée.`
      },
      {
        title: '4. Responsabilités et Garanties de l\'Utilisateur',
        content: `En utilisant le Service, vous garantissez et déclarez que :

• Vous êtes résident de la Suisse ou de l'Union Européenne (pas des États-Unis)
• Vous avez le droit légal de télécharger et d'utiliser toutes les photos que vous soumettez
• Pour les photos de mineurs, vous êtes le parent ou le tuteur légal, ou avez obtenu l'autorisation explicite du parent/tuteur
• Vous ne téléchargerez pas de photos de personnes sans leur consentement
• Toutes les informations que vous fournissez sont exactes et non trompeuses
• Vous n'utiliserez pas le Service à des fins illégales
• Vous ne téléchargerez pas de contenu diffamatoire, obscène ou portant atteinte aux droits de tiers`
      },
      {
        title: '5. Propriété Intellectuelle',
        content: `• Vous conservez tous les droits sur les photos originales que vous téléchargez
• Vous nous accordez une licence limitée pour traiter vos photos uniquement dans le but de créer votre histoire personnalisée
• Le contenu de l'histoire générée et les illustrations deviennent votre propriété après l'achat
• Notre plateforme, technologie et marque restent notre propriété intellectuelle`
      },
      {
        title: '6. Responsabilité du Contenu et des Résultats',
        content: `• Le contenu généré par l'IA peut occasionnellement produire des résultats inattendus
• Vous êtes responsable de la révision du contenu généré avant de le finaliser ou de le partager
• Vous assumez l'entière responsabilité de toute utilisation des histoires générées
• Nous ne garantissons pas que le contenu généré par l'IA sera exempt d'erreurs ou adapté à tous les usages`
      },
      {
        title: '7. Limitation de Responsabilité',
        content: `DANS LA MESURE MAXIMALE PERMISE PAR LA LOI :

• Le Service est fourni "tel quel" sans garantie d'aucune sorte
• Nous ne sommes pas responsables des dommages indirects, accessoires, spéciaux ou consécutifs
• Notre responsabilité totale ne dépassera pas le montant que vous avez payé pour le service spécifique
• Nous ne sommes pas responsables des réclamations découlant de votre mauvaise utilisation du Service ou de la violation de ces conditions`
      },
      {
        title: '8. Indemnisation',
        content: `Vous acceptez d'indemniser, de défendre et de dégager de toute responsabilité Magical Story, ses dirigeants, directeurs, employés et agents contre toute réclamation, dommage, perte ou dépense (y compris les frais juridiques) découlant de :

• Votre utilisation du Service
• Votre violation de ces Conditions
• Votre violation des droits de tiers
• Le contenu que vous téléchargez ou créez en utilisant le Service`
      },
      {
        title: '9. Traitement des Données',
        content: `• Les photos sont traitées à l'aide de la technologie IA pour créer des illustrations d'avatar
• Les photos originales sont stockées temporairement pour le traitement et sont supprimées conformément à notre Politique de Confidentialité
• Nous ne vendons ni ne partageons vos photos personnelles avec des tiers à des fins marketing
• Consultez notre Politique de Confidentialité pour les détails complets sur le traitement des données`
      },
      {
        title: '10. Conditions d\'Âge',
        content: `• Vous devez avoir au moins 18 ans pour créer un compte
• Les parents/tuteurs peuvent créer des histoires mettant en scène leurs enfants mineurs
• En téléchargeant des photos de mineurs, vous confirmez avoir l'autorité parentale ou le consentement explicite`
      },
      {
        title: '11. Modifications des Conditions',
        content: `Nous nous réservons le droit de modifier ces Conditions à tout moment. L'utilisation continue du Service après les modifications constitue l'acceptation des nouvelles conditions. Nous informerons les utilisateurs des changements importants par e-mail ou notification sur la plateforme.`
      },
      {
        title: '12. Résiliation',
        content: `Nous pouvons résilier ou suspendre votre compte à tout moment en cas de violation de ces Conditions. À la résiliation, votre droit d'utiliser le Service cesse immédiatement.`
      },
      {
        title: '13. Droit Applicable et Juridiction',
        content: `• Ces Conditions sont régies exclusivement par les lois de la Suisse
• Tout litige découlant de ces Conditions ou de votre utilisation du Service sera résolu exclusivement devant les tribunaux de Zurich, Suisse
• Vous acceptez de vous soumettre à la compétence exclusive des tribunaux de Zurich, Suisse
• La Convention des Nations Unies sur les contrats de vente internationale de marchandises ne s'applique pas`
      },
      {
        title: '14. Contact',
        content: `Pour toute question concernant ces Conditions, veuillez nous contacter à : legal@magicalstory.com`
      }
    ]
  }
};

export default function TermsOfService() {
  const { language } = useLanguage();
  const navigate = useNavigate();
  const content = termsContent[language] || termsContent.en;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 max-w-4xl mx-auto px-4 py-8">
        <button
          onClick={() => navigate(-1)}
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
