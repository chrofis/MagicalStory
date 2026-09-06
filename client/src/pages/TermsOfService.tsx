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
• You own the copyright to any photos you upload, OR you have obtained explicit permission from the copyright holder (typically the photographer)
• You have obtained explicit consent from every individual depicted in uploaded photos for the creation of AI-generated avatars and stories
• For photos of minors, you are the parent or legal guardian with full authority to grant such consent
• You will NOT upload photos of celebrities, public figures, or any person without their explicit written consent
• You will NOT create characters that imitate, reference, or infringe upon copyrighted fictional characters (e.g., from movies, books, games)
• All information you provide is accurate and not misleading
• You will not use the Service for any unlawful purpose`
      },
      {
        title: '5. Prohibited Content and Acceptable Use',
        content: `The following content is strictly prohibited:

• Photos of individuals without their consent
• Photos of celebrities or public figures without documented permission
• Character descriptions mimicking copyrighted fictional characters
• Content that is defamatory, libelous, or harmful to any person's reputation
• Hate speech, harassment, or discriminatory content
• Sexually explicit, obscene, or pornographic content
• Content depicting violence, gore, or illegal activities
• Content that exploits or harms minors in any way
• Any content that violates applicable laws

We reserve the right to refuse service, remove content, and terminate accounts that violate this policy without notice or refund.`
      },
      {
        title: '6. Intellectual Property',
        content: `• You retain all rights to the original photos you upload
• You grant us a non-exclusive, worldwide, royalty-free license to use, copy, modify, and display uploaded content solely for providing the Service
• The generated story content and illustrations become your property upon purchase
• You may use generated stories for personal, non-commercial purposes
• Commercial use of generated content requires separate licensing
• Our platform, technology, and branding remain our intellectual property`
      },
      {
        title: '7. Content Review and Final Responsibility',
        content: `IMPORTANT: You are the final publisher of your story.

• The Service provides AI-generated draft content that YOU must review before finalizing
• By saving, downloading, or sharing your story, you confirm that you have reviewed all content
• You accept sole and full responsibility for the final content and its compliance with all laws
• You are responsible for ensuring the story does not defame, harm, or infringe upon anyone's rights
• The platform is a tool; you are the publisher of the final work`
      },
      {
        title: '8. Copyright Claims and Takedowns',
        content: `We respect intellectual property rights and respond to valid infringement notices.

• If you believe content infringes your copyright, contact us at legal@magicalstory.ch with: (1) identification of the copyrighted work, (2) identification of the infringing material, (3) your contact information, (4) a statement of good faith belief, and (5) a statement under penalty of perjury that you are authorized to act
• We will investigate and may remove content that infringes intellectual property rights
• Repeat infringers will have their accounts terminated`
      },
      {
        title: '9. Reporting Violations',
        content: `If you encounter content that violates these Terms or applicable laws:

• Report it immediately to legal@magicalstory.ch
• Include details of the violation and any relevant evidence
• We will investigate all reports and take appropriate action
• We may remove content and terminate accounts without prior notice`
      },
      {
        title: '10. Limitation of Liability',
        content: `TO THE MAXIMUM EXTENT PERMITTED BY LAW:

• The Service is provided "as is" without warranties of any kind
• We are not liable for any indirect, incidental, special, or consequential damages
• Our total liability shall not exceed the amount you paid for the specific service giving rise to the claim
• We are not responsible for any claims arising from your misuse of the Service or violation of these terms`
      },
      {
        title: '11. Indemnification',
        content: `You agree to indemnify, defend, and hold harmless Magical Story, its officers, directors, employees, and agents from any claims, damages, losses, or expenses (including legal fees) arising from:

• Your use of the Service
• Your violation of these Terms
• Your violation of any third-party rights
• Content you upload or create using the Service`
      },
      {
        title: '12. Data Processing',
        content: `• Photos are processed using AI technology to create avatar illustrations
• By uploading photos, you consent to the processing of facial features and biometric data for avatar creation
• Original photos are stored temporarily for processing and are deleted according to our Privacy Policy
• We do not sell or share your personal photos with third parties for marketing purposes
• See our Privacy Policy for complete details on data handling`
      },
      {
        title: '13. Age Requirements',
        content: `• You must be at least 18 years old to create an account
• Parents/guardians may create stories featuring their minor children
• By uploading photos of minors, you confirm you have parental authority or explicit consent`
      },
      {
        title: '14. Modifications to Terms',
        content: `We reserve the right to modify these Terms at any time. Continued use of the Service after changes constitutes acceptance of the new terms. We will notify users of significant changes via email or platform notification.`
      },
      {
        title: '15. Termination',
        content: `We may terminate or suspend your account at any time for violation of these Terms. Upon termination, your right to use the Service ceases immediately.`
      },
      {
        title: '16. Governing Law and Jurisdiction',
        content: `• These Terms are governed exclusively by the laws of Switzerland
• Any disputes arising from these Terms or your use of the Service shall be resolved exclusively in the courts of Zurich, Switzerland
• You agree to submit to the exclusive jurisdiction of the courts of Zurich, Switzerland
• The United Nations Convention on Contracts for the International Sale of Goods does not apply`
      },
      {
        title: '17. Contact',
        content: `For questions about these Terms, please contact us at: legal@magicalstory.ch`
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
        content: `WICHTIG: Dieser Dienst ist ausschliesslich für Einwohner der Schweiz und der Europäischen Union bestimmt.

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
• Sie das Urheberrecht an allen hochgeladenen Fotos besitzen ODER die ausdrückliche Genehmigung des Urheberrechtsinhabers (typischerweise des Fotografen) eingeholt haben
• Sie die ausdrückliche Zustimmung aller auf den Fotos abgebildeten Personen zur Erstellung von KI-generierten Avataren und Geschichten eingeholt haben
• Bei Fotos von Minderjährigen Sie der Elternteil oder gesetzliche Vormund mit voller Befugnis zur Erteilung dieser Zustimmung sind
• Sie KEINE Fotos von Prominenten, öffentlichen Personen oder anderen Personen ohne deren ausdrückliche schriftliche Zustimmung hochladen
• Sie KEINE Charaktere erstellen, die urheberrechtlich geschützte fiktive Figuren nachahmen oder darauf verweisen (z.B. aus Filmen, Büchern, Spielen)
• Alle von Ihnen bereitgestellten Informationen korrekt und nicht irreführend sind
• Sie den Dienst nicht für rechtswidrige Zwecke nutzen werden`
      },
      {
        title: '5. Verbotene Inhalte und Nutzungsbedingungen',
        content: `Folgende Inhalte sind streng verboten:

• Fotos von Personen ohne deren Zustimmung
• Fotos von Prominenten oder öffentlichen Personen ohne dokumentierte Genehmigung
• Charakterbeschreibungen, die urheberrechtlich geschützte fiktive Figuren nachahmen
• Inhalte, die diffamierend, verleumderisch oder dem Ruf einer Person schaden
• Hassrede, Belästigung oder diskriminierende Inhalte
• Sexuell explizite, obszöne oder pornografische Inhalte
• Inhalte, die Gewalt, Gore oder illegale Aktivitäten darstellen
• Inhalte, die Minderjährige in irgendeiner Weise ausbeuten oder schaden
• Alle Inhalte, die gegen geltendes Recht verstossen

Wir behalten uns das Recht vor, den Dienst zu verweigern, Inhalte zu entfernen und Konten ohne Vorankündigung oder Rückerstattung zu kündigen.`
      },
      {
        title: '6. Geistiges Eigentum',
        content: `• Sie behalten alle Rechte an den von Ihnen hochgeladenen Originalfotos
• Sie gewähren uns eine nicht-exklusive, weltweite, gebührenfreie Lizenz zur Nutzung, Kopie, Änderung und Anzeige hochgeladener Inhalte ausschliesslich zur Bereitstellung des Dienstes
• Die generierten Geschichtsinhalte und Illustrationen werden nach dem Kauf Ihr Eigentum
• Sie dürfen generierte Geschichten für persönliche, nicht-kommerzielle Zwecke verwenden
• Kommerzielle Nutzung generierter Inhalte erfordert eine separate Lizenzierung
• Unsere Plattform, Technologie und Marke bleiben unser geistiges Eigentum`
      },
      {
        title: '7. Inhaltsprüfung und Endverantwortung',
        content: `WICHTIG: Sie sind der endgültige Herausgeber Ihrer Geschichte.

• Der Dienst stellt KI-generierte Entwurfsinhalte bereit, die SIE vor der Fertigstellung prüfen müssen
• Durch das Speichern, Herunterladen oder Teilen Ihrer Geschichte bestätigen Sie, dass Sie alle Inhalte geprüft haben
• Sie übernehmen die alleinige und vollständige Verantwortung für den endgültigen Inhalt und dessen Einhaltung aller Gesetze
• Sie sind dafür verantwortlich, dass die Geschichte niemanden diffamiert, schädigt oder dessen Rechte verletzt
• Die Plattform ist ein Werkzeug; Sie sind der Herausgeber des endgültigen Werks`
      },
      {
        title: '8. Urheberrechtsansprüche und Löschung',
        content: `Wir respektieren geistige Eigentumsrechte und reagieren auf gültige Verletzungsanzeigen.

• Wenn Sie glauben, dass Inhalte Ihr Urheberrecht verletzen, kontaktieren Sie uns unter legal@magicalstory.ch mit: (1) Identifizierung des urheberrechtlich geschützten Werks, (2) Identifizierung des verletzenden Materials, (3) Ihre Kontaktdaten, (4) eine Erklärung in gutem Glauben, und (5) eine eidesstattliche Erklärung, dass Sie zur Handlung berechtigt sind
• Wir werden alle Ansprüche untersuchen und möglicherweise Inhalte entfernen, die geistige Eigentumsrechte verletzen
• Wiederholte Rechtsverletzer werden ihre Konten gekündigt`
      },
      {
        title: '9. Meldung von Verstössen',
        content: `Wenn Sie Inhalte finden, die gegen diese Bedingungen oder geltendes Recht verstossen:

• Melden Sie diese sofort an legal@magicalstory.ch
• Fügen Sie Details des Verstosses und relevante Beweise bei
• Wir werden alle Meldungen untersuchen und entsprechende Massnahmen ergreifen
• Wir können Inhalte entfernen und Konten ohne Vorankündigung kündigen`
      },
      {
        title: '10. Haftungsbeschränkung',
        content: `IM GESETZLICH ZULÄSSIGEN RAHMEN:

• Der Dienst wird "wie besehen" ohne jegliche Garantien bereitgestellt
• Wir haften nicht für indirekte, zufällige, besondere oder Folgeschäden
• Unsere Gesamthaftung übersteigt nicht den Betrag, den Sie für den spezifischen Dienst bezahlt haben, der den Anspruch begründet
• Wir sind nicht verantwortlich für Ansprüche, die aus Ihrem Missbrauch des Dienstes oder Ihrer Verletzung dieser Bedingungen entstehen`
      },
      {
        title: '11. Freistellung',
        content: `Sie verpflichten sich, Magical Story, seine leitenden Angestellten, Direktoren, Mitarbeiter und Vertreter von allen Ansprüchen, Schäden, Verlusten oder Kosten (einschliesslich Anwaltsgebühren) freizustellen, zu verteidigen und schadlos zu halten, die entstehen aus:

• Ihrer Nutzung des Dienstes
• Ihrer Verletzung dieser Bedingungen
• Ihrer Verletzung von Rechten Dritter
• Inhalten, die Sie hochladen oder mit dem Dienst erstellen`
      },
      {
        title: '12. Datenverarbeitung',
        content: `• Fotos werden mit KI-Technologie verarbeitet, um Avatar-Illustrationen zu erstellen
• Durch das Hochladen von Fotos stimmen Sie der Verarbeitung von Gesichtsmerkmalen und biometrischen Daten zur Avatar-Erstellung zu
• Originalfotos werden vorübergehend zur Verarbeitung gespeichert und gemäss unserer Datenschutzrichtlinie gelöscht
• Wir verkaufen oder teilen Ihre persönlichen Fotos nicht zu Marketingzwecken mit Dritten
• Siehe unsere Datenschutzrichtlinie für vollständige Details zur Datenverarbeitung`
      },
      {
        title: '13. Altersanforderungen',
        content: `• Sie müssen mindestens 18 Jahre alt sein, um ein Konto zu erstellen
• Eltern/Erziehungsberechtigte können Geschichten mit ihren minderjährigen Kindern erstellen
• Durch das Hochladen von Fotos von Minderjährigen bestätigen Sie, dass Sie elterliche Autorität oder ausdrückliche Zustimmung haben`
      },
      {
        title: '14. Änderungen der Bedingungen',
        content: `Wir behalten uns das Recht vor, diese Bedingungen jederzeit zu ändern. Die fortgesetzte Nutzung des Dienstes nach Änderungen gilt als Annahme der neuen Bedingungen. Wir werden Benutzer über wesentliche Änderungen per E-Mail oder Plattformbenachrichtigung informieren.`
      },
      {
        title: '15. Kündigung',
        content: `Wir können Ihr Konto jederzeit bei Verstoss gegen diese Bedingungen kündigen oder sperren. Bei Kündigung erlischt Ihr Recht zur Nutzung des Dienstes sofort.`
      },
      {
        title: '16. Anwendbares Recht und Gerichtsstand',
        content: `• Diese Bedingungen unterliegen ausschliesslich dem Recht der Schweiz
• Alle Streitigkeiten aus diesen Bedingungen oder Ihrer Nutzung des Dienstes werden ausschliesslich vor den Gerichten in Zürich, Schweiz, beigelegt
• Sie stimmen der ausschliesslichen Zuständigkeit der Gerichte in Zürich, Schweiz, zu
• Das Übereinkommen der Vereinten Nationen über Verträge über den internationalen Warenkauf findet keine Anwendung`
      },
      {
        title: '17. Kontakt',
        content: `Bei Fragen zu diesen Bedingungen kontaktieren Sie uns bitte unter: legal@magicalstory.ch`
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
• Vous possédez les droits d'auteur sur toutes les photos que vous téléchargez, OU vous avez obtenu l'autorisation explicite du détenteur des droits d'auteur (généralement le photographe)
• Vous avez obtenu le consentement explicite de chaque personne représentée sur les photos pour la création d'avatars et d'histoires générés par l'IA
• Pour les photos de mineurs, vous êtes le parent ou tuteur légal avec pleine autorité pour accorder ce consentement
• Vous ne téléchargerez PAS de photos de célébrités, personnalités publiques ou toute personne sans leur consentement écrit explicite
• Vous ne créerez PAS de personnages qui imitent, font référence à ou violent les droits d'auteur de personnages fictifs (ex : films, livres, jeux vidéo)
• Toutes les informations que vous fournissez sont exactes et non trompeuses
• Vous n'utiliserez pas le Service à des fins illégales`
      },
      {
        title: '5. Contenu Interdit et Utilisation Acceptable',
        content: `Les contenus suivants sont strictement interdits :

• Photos de personnes sans leur consentement
• Photos de célébrités ou personnalités publiques sans autorisation documentée
• Descriptions de personnages imitant des personnages fictifs protégés par le droit d'auteur
• Contenu diffamatoire, calomnieux ou nuisible à la réputation de toute personne
• Discours de haine, harcèlement ou contenu discriminatoire
• Contenu sexuellement explicite, obscène ou pornographique
• Contenu représentant la violence, le gore ou des activités illégales
• Contenu exploitant ou nuisant aux mineurs de quelque manière que ce soit
• Tout contenu violant les lois applicables

Nous nous réservons le droit de refuser le service, de supprimer le contenu et de résilier les comptes qui violent cette politique sans préavis ni remboursement.`
      },
      {
        title: '6. Propriété Intellectuelle',
        content: `• Vous conservez tous les droits sur les photos originales que vous téléchargez
• Vous nous accordez une licence non exclusive, mondiale et libre de redevances pour utiliser, copier, modifier et afficher le contenu téléchargé uniquement pour fournir le Service
• Le contenu de l'histoire générée et les illustrations deviennent votre propriété après l'achat
• Vous pouvez utiliser les histoires générées à des fins personnelles et non commerciales
• L'utilisation commerciale du contenu généré nécessite une licence séparée
• Notre plateforme, technologie et marque restent notre propriété intellectuelle`
      },
      {
        title: '7. Révision du Contenu et Responsabilité Finale',
        content: `IMPORTANT : Vous êtes l'éditeur final de votre histoire.

• Le Service fournit un contenu brouillon généré par l'IA que VOUS devez réviser avant de le finaliser
• En enregistrant, téléchargeant ou partageant votre histoire, vous confirmez avoir révisé tout le contenu
• Vous acceptez la responsabilité entière et exclusive du contenu final et de sa conformité à toutes les lois
• Vous êtes responsable de vous assurer que l'histoire ne diffame, ne nuit ou ne viole les droits de personne
• La plateforme est un outil ; vous êtes l'éditeur de l'œuvre finale`
      },
      {
        title: '8. Réclamations de Droits d\'Auteur et Suppression',
        content: `Nous respectons les droits de propriété intellectuelle et répondons aux avis de violation valides.

• Si vous pensez qu'un contenu viole vos droits d'auteur, contactez-nous à legal@magicalstory.ch avec : (1) l'identification de l'œuvre protégée, (2) l'identification du matériel contrefaisant, (3) vos coordonnées, (4) une déclaration de bonne foi, et (5) une déclaration sous serment attestant que vous êtes autorisé à agir
• Nous examinerons et pourrons supprimer le contenu qui viole les droits de propriété intellectuelle
• Les contrevenants récidivistes verront leurs comptes résiliés`
      },
      {
        title: '9. Signalement des Violations',
        content: `Si vous rencontrez un contenu qui viole ces Conditions ou les lois applicables :

• Signalez-le immédiatement à legal@magicalstory.ch
• Incluez les détails de la violation et toute preuve pertinente
• Nous examinerons tous les signalements et prendrons les mesures appropriées
• Nous pouvons supprimer le contenu et résilier les comptes sans préavis`
      },
      {
        title: '10. Limitation de Responsabilité',
        content: `DANS LA MESURE MAXIMALE PERMISE PAR LA LOI :

• Le Service est fourni "tel quel" sans garantie d'aucune sorte
• Nous ne sommes pas responsables des dommages indirects, accessoires, spéciaux ou consécutifs
• Notre responsabilité totale ne dépassera pas le montant que vous avez payé pour le service spécifique donnant lieu à la réclamation
• Nous ne sommes pas responsables des réclamations découlant de votre mauvaise utilisation du Service ou de la violation de ces conditions`
      },
      {
        title: '11. Indemnisation',
        content: `Vous acceptez d'indemniser, de défendre et de dégager de toute responsabilité Magical Story, ses dirigeants, directeurs, employés et agents contre toute réclamation, dommage, perte ou dépense (y compris les frais juridiques) découlant de :

• Votre utilisation du Service
• Votre violation de ces Conditions
• Votre violation des droits de tiers
• Le contenu que vous téléchargez ou créez en utilisant le Service`
      },
      {
        title: '12. Traitement des Données',
        content: `• Les photos sont traitées à l'aide de la technologie IA pour créer des illustrations d'avatar
• En téléchargeant des photos, vous consentez au traitement des caractéristiques faciales et des données biométriques pour la création d'avatars
• Les photos originales sont stockées temporairement pour le traitement et sont supprimées conformément à notre Politique de Confidentialité
• Nous ne vendons ni ne partageons vos photos personnelles avec des tiers à des fins marketing
• Consultez notre Politique de Confidentialité pour les détails complets sur le traitement des données`
      },
      {
        title: '13. Conditions d\'Âge',
        content: `• Vous devez avoir au moins 18 ans pour créer un compte
• Les parents/tuteurs peuvent créer des histoires mettant en scène leurs enfants mineurs
• En téléchargeant des photos de mineurs, vous confirmez avoir l'autorité parentale ou le consentement explicite`
      },
      {
        title: '14. Modifications des Conditions',
        content: `Nous nous réservons le droit de modifier ces Conditions à tout moment. L'utilisation continue du Service après les modifications constitue l'acceptation des nouvelles conditions. Nous informerons les utilisateurs des changements importants par e-mail ou notification sur la plateforme.`
      },
      {
        title: '15. Résiliation',
        content: `Nous pouvons résilier ou suspendre votre compte à tout moment en cas de violation de ces Conditions. À la résiliation, votre droit d'utiliser le Service cesse immédiatement.`
      },
      {
        title: '16. Droit Applicable et Juridiction',
        content: `• Ces Conditions sont régies exclusivement par les lois de la Suisse
• Tout litige découlant de ces Conditions ou de votre utilisation du Service sera résolu exclusivement devant les tribunaux de Zurich, Suisse
• Vous acceptez de vous soumettre à la compétence exclusive des tribunaux de Zurich, Suisse
• La Convention des Nations Unies sur les contrats de vente internationale de marchandises ne s'applique pas`
      },
      {
        title: '17. Contact',
        content: `Pour toute question concernant ces Conditions, veuillez nous contacter à : legal@magicalstory.ch`
      }
    ]
  },
  it: {
    title: 'Termini di Servizio',
    lastUpdated: 'Ultimo aggiornamento: gennaio 2025',
    sections: [
      {
        title: '1. Accettazione dei Termini',
        content: `Accedendo e utilizzando Magical Story ("il Servizio"), accetti di essere vincolato dai presenti Termini di Servizio. Se non accetti questi termini, ti preghiamo di non utilizzare il Servizio.`
      },
      {
        title: '2. Disponibilità del Servizio e Idoneità',
        content: `IMPORTANTE: questo Servizio è destinato esclusivamente ai residenti della Svizzera e dell'Unione Europea.

• Questo Servizio NON è disponibile per residenti o cittadini degli Stati Uniti d'America
• Utilizzando questo Servizio, dichiari e garantisci di essere residente in Svizzera o in uno Stato membro dell'Unione Europea
• Confermi di accedere a questo Servizio dalla Svizzera o dall'Unione Europea
• Qualsiasi tentativo di accedere a questo Servizio dagli Stati Uniti o da parte di residenti statunitensi è vietato
• Ci riserviamo il diritto di chiudere account e di rifiutare il servizio a chiunque dichiari il falso in merito alla propria residenza o posizione`
      },
      {
        title: '3. Descrizione del Servizio',
        content: `Magical Story è una piattaforma basata sull'intelligenza artificiale che crea libri di storie personalizzati sulla base di foto e descrizioni dei personaggi che fornisci. Le foto vengono trasformate in avatar illustrati che compaiono nella tua storia personalizzata.`
      },
      {
        title: '4. Responsabilità e Garanzie dell\'Utente',
        content: `Utilizzando il Servizio, dichiari e garantisci che:

• Sei residente in Svizzera o nell'Unione Europea (non negli Stati Uniti)
• Possiedi i diritti d'autore su qualsiasi foto carichi, OPPURE hai ottenuto l'autorizzazione esplicita del titolare dei diritti d'autore (di norma il fotografo)
• Hai ottenuto il consenso esplicito di ogni persona ritratta nelle foto caricate per la creazione di avatar e storie generati dall'IA
• Per le foto di minori, sei il genitore o il tutore legale con piena autorità per concedere tale consenso
• NON caricherai foto di celebrità, personaggi pubblici o di qualsiasi persona senza il loro esplicito consenso scritto
• NON creerai personaggi che imitano, fanno riferimento a, o violano personaggi immaginari protetti da diritto d'autore (ad es. da film, libri, giochi)
• Tutte le informazioni fornite sono accurate e non fuorvianti
• Non utilizzerai il Servizio per alcuno scopo illecito`
      },
      {
        title: '5. Contenuti Vietati e Uso Consentito',
        content: `I seguenti contenuti sono severamente vietati:

• Foto di persone senza il loro consenso
• Foto di celebrità o personaggi pubblici senza autorizzazione documentata
• Descrizioni di personaggi che imitano personaggi immaginari protetti da diritto d'autore
• Contenuti diffamatori, calunniosi o dannosi per la reputazione di una persona
• Incitamento all'odio, molestie o contenuti discriminatori
• Contenuti sessualmente espliciti, osceni o pornografici
• Contenuti che raffigurano violenza, gore o attività illegali
• Contenuti che sfruttano o danneggiano minori in qualsiasi modo
• Qualsiasi contenuto che violi le leggi applicabili

Ci riserviamo il diritto di rifiutare il servizio, rimuovere contenuti e chiudere account che violino questa politica senza preavviso né rimborso.`
      },
      {
        title: '6. Proprietà Intellettuale',
        content: `• Mantieni tutti i diritti sulle foto originali che carichi
• Ci concedi una licenza non esclusiva, mondiale e gratuita per usare, copiare, modificare e visualizzare i contenuti caricati esclusivamente ai fini della fornitura del Servizio
• Il contenuto della storia generata e le illustrazioni diventano di tua proprietà dopo l'acquisto
• Puoi utilizzare le storie generate per scopi personali e non commerciali
• L'uso commerciale dei contenuti generati richiede una licenza separata
• La nostra piattaforma, tecnologia e marchio restano di nostra proprietà intellettuale`
      },
      {
        title: '7. Revisione dei Contenuti e Responsabilità Finale',
        content: `IMPORTANTE: sei tu l'editore finale della tua storia.

• Il Servizio fornisce contenuti in bozza generati dall'IA che TU devi revisionare prima della finalizzazione
• Salvando, scaricando o condividendo la tua storia, confermi di aver revisionato tutti i contenuti
• Accetti la responsabilità esclusiva e completa per il contenuto finale e per la sua conformità a tutte le leggi
• Sei responsabile di assicurarti che la storia non diffami, danneggi o violi i diritti di nessuno
• La piattaforma è uno strumento; tu sei l'editore dell'opera finale`
      },
      {
        title: '8. Reclami per Violazione del Diritto d\'Autore e Rimozioni',
        content: `Rispettiamo i diritti di proprietà intellettuale e rispondiamo a segnalazioni di violazione valide.

• Se ritieni che un contenuto violi il tuo diritto d'autore, contattaci all'indirizzo legal@magicalstory.ch indicando: (1) l'identificazione dell'opera protetta da diritto d'autore, (2) l'identificazione del materiale che viola tale diritto, (3) i tuoi dati di contatto, (4) una dichiarazione di buona fede, e (5) una dichiarazione, sotto pena di spergiuro, di essere autorizzato ad agire
• Esamineremo la segnalazione e potremmo rimuovere i contenuti che violano diritti di proprietà intellettuale
• Ai trasgressori recidivi verrà chiuso l'account`
      },
      {
        title: '9. Segnalazione di Violazioni',
        content: `Se riscontri contenuti che violano questi Termini o le leggi applicabili:

• Segnalali immediatamente a legal@magicalstory.ch
• Includi i dettagli della violazione e qualsiasi prova rilevante
• Esamineremo tutte le segnalazioni e adotteremo le misure appropriate
• Potremmo rimuovere i contenuti e chiudere gli account senza preavviso`
      },
      {
        title: '10. Limitazione di Responsabilità',
        content: `NELLA MISURA MASSIMA CONSENTITA DALLA LEGGE:

• Il Servizio è fornito "così com'è" senza garanzie di alcun tipo
• Non siamo responsabili per danni indiretti, incidentali, speciali o consequenziali
• La nostra responsabilità totale non supererà l'importo che hai pagato per lo specifico servizio da cui deriva la richiesta
• Non siamo responsabili per richieste derivanti da un uso improprio del Servizio o dalla violazione di questi termini da parte tua`
      },
      {
        title: '11. Manleva',
        content: `Accetti di manlevare, difendere e tenere indenne Magical Story, i suoi dirigenti, amministratori, dipendenti e agenti da qualsiasi rivendicazione, danno, perdita o spesa (comprese le spese legali) derivante da:

• Il tuo utilizzo del Servizio
• La tua violazione di questi Termini
• La tua violazione di diritti di terzi
• Contenuti che carichi o crei utilizzando il Servizio`
      },
      {
        title: '12. Trattamento dei Dati',
        content: `• Le foto vengono trattate mediante tecnologia IA per creare illustrazioni avatar
• Caricando le foto, acconsenti al trattamento dei tratti del viso e dei dati biometrici per la creazione dell'avatar
• Le foto originali vengono conservate temporaneamente per il trattamento e vengono eliminate secondo quanto previsto dalla nostra Informativa sulla Privacy
• Non vendiamo né condividiamo le tue foto personali con terzi per scopi di marketing
• Consulta la nostra Informativa sulla Privacy per i dettagli completi sul trattamento dei dati`
      },
      {
        title: '13. Requisiti di Età',
        content: `• Devi avere almeno 18 anni per creare un account
• I genitori/tutori possono creare storie con i propri figli minorenni come protagonisti
• Caricando foto di minori, confermi di avere l'autorità genitoriale o il consenso esplicito`
      },
      {
        title: '14. Modifiche ai Termini',
        content: `Ci riserviamo il diritto di modificare questi Termini in qualsiasi momento. L'uso continuato del Servizio dopo le modifiche costituisce accettazione dei nuovi termini. Informeremo gli utenti di modifiche significative via email o tramite notifica sulla piattaforma.`
      },
      {
        title: '15. Risoluzione',
        content: `Possiamo risolvere o sospendere il tuo account in qualsiasi momento in caso di violazione di questi Termini. Alla risoluzione, il tuo diritto di utilizzare il Servizio cessa immediatamente.`
      },
      {
        title: '16. Legge Applicabile e Foro Competente',
        content: `• Questi Termini sono disciplinati esclusivamente dal diritto svizzero
• Qualsiasi controversia derivante da questi Termini o dal tuo utilizzo del Servizio sarà risolta esclusivamente dai tribunali di Zurigo, Svizzera
• Accetti di sottoporti alla giurisdizione esclusiva dei tribunali di Zurigo, Svizzera
• La Convenzione delle Nazioni Unite sui contratti di compravendita internazionale di merci non si applica`
      },
      {
        title: '17. Contatti',
        content: `Per domande su questi Termini, contattaci all'indirizzo: legal@magicalstory.ch`
      }
    ]
  }
};

export default function TermsOfService() {
  const { language } = useLanguage();
  const navigate = useNavigate();
  const content = termsContent[language as keyof typeof termsContent] || termsContent.en;

  const handleBack = () => {
    // Check if there's history to go back to
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      // If opened in new tab with no history, go to home
      navigate('/');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation currentStep={0} />

      <div className="flex-1 max-w-4xl mx-auto px-4 py-8">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-indigo-500 hover:text-indigo-800 mb-6"
        >
          <ArrowLeft size={20} />
          {language === 'de' ? 'Zurück' : language === 'fr' ? 'Retour' : language === 'it' ? 'Indietro' : 'Back'}
        </button>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">{content.title}</h1>
        <p className="text-gray-500 mb-8">{content.lastUpdated}</p>

        <div className="bg-white rounded-2xl shadow-sm p-6 md:p-8 space-y-8">
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
