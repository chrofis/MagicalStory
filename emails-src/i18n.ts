/**
 * Translation strings for every email template, keyed by language code.
 *
 * Copy is the original wording from the pre-redesign templates. The redesign
 * only changes the visual chrome (layout, colours, fonts, card shell) —
 * the words themselves are left as they were so tone stays consistent with
 * everything users have read before.
 *
 * Swiss German uses `ss` never `ß`. Placeholders are raw `{name}` tokens —
 * they survive React rendering as plain text and get substituted by
 * `email.js` at send time. Conditional blocks `{?key}...{/key}` are rendered
 * by the `<Cond when="key">…</Cond>` helper.
 *
 * A few templates (notably `trial-reminder`) also surface placeholders for
 * dynamic copy that `email.js` computes per send (variant copy for day-5 vs
 * day-25). Those placeholders are kept here as literal tokens too.
 */

export type Lang = 'en' | 'de' | 'fr' | 'it';

export const LANGS: Lang[] = ['en', 'de', 'fr', 'it'];

// Map our short codes to the [LANGUAGE] markers email.js expects.
export const langMarkers: Record<Lang, string> = {
  en: 'ENGLISH',
  de: 'GERMAN',
  fr: 'FRENCH',
  it: 'ITALIAN',
};

// ─── Shared footer copy ──────────────────────────────────────────────────────
// Two-line footer:
//   1. tagline
//   2. magicalstory.ch · info@magicalstory.ch · {country}   (built by Footer)
export const footer: Record<Lang, { tagline: string; country: string }> = {
  en: { tagline: 'MagicalStory - Creating Magical Moments, One Story at a Time', country: 'Switzerland' },
  de: { tagline: 'MagicalStory - Magische Momente schaffen, eine Geschichte nach der anderen', country: 'Schweiz' },
  fr: { tagline: 'MagicalStory - Des moments magiques, une histoire à la fois', country: 'Suisse' },
  it: { tagline: 'MagicalStory - Momenti magici, una storia alla volta', country: 'Svizzera' },
};

// ─── story-complete ──────────────────────────────────────────────────────────
// Placeholders: {greeting}, {title}, {storyUrl}, {?coverUrl}{/coverUrl}.
export const storyComplete: Record<Lang, {
  subject: string; preview: string; headline: string; greeting: string;
  body: string; cta: string; perksIntro: string; perks: string[]; signoff: string;
}> = {
  en: {
    subject: 'Your magical story "{title}" is ready!',
    preview: 'Your personalized story is ready — view it, order a printed book, or download as PDF.',
    headline: 'Your story is ready!',
    greeting: 'Hello {greeting},',
    body: 'Great news! Your personalized story "{title}" has been created and is waiting for you.',
    cta: 'View Your Story',
    perksIntro: 'You can now:',
    perks: [
      'Read your story',
      'Share it with family or friends',
      "Edit or adjust the story if you'd like changes",
      'Order a printed book',
      'Download as PDF',
    ],
    signoff: 'Thank you for using MagicalStory!',
  },
  de: {
    subject: 'Deine magische Geschichte "{title}" ist fertig!',
    preview: 'Deine personalisierte Geschichte ist fertig — ansehen, als Buch bestellen oder als PDF herunterladen.',
    headline: 'Deine Geschichte ist fertig!',
    greeting: 'Hallo {greeting},',
    body: 'Tolle Neuigkeiten! Deine personalisierte Geschichte "{title}" wurde erstellt und wartet auf dich.',
    cta: 'Geschichte ansehen',
    perksIntro: 'Du kannst jetzt:',
    perks: [
      'Deine Geschichte lesen',
      'Mit Familie oder Freunden teilen',
      'Die Geschichte bearbeiten oder anpassen, falls du Änderungen möchtest',
      'Ein gedrucktes Buch bestellen',
      'Als PDF herunterladen',
    ],
    signoff: 'Vielen Dank, dass du MagicalStory nutzt!',
  },
  fr: {
    subject: 'Votre histoire magique "{title}" est prête!',
    preview: 'Votre histoire personnalisée est prête — voir, commander en livre imprimé ou télécharger en PDF.',
    headline: 'Votre histoire est prête!',
    greeting: 'Bonjour {greeting},',
    body: 'Bonne nouvelle! Votre histoire personnalisée "{title}" a été créée et vous attend.',
    cta: 'Voir votre histoire',
    perksIntro: 'Vous pouvez maintenant :',
    perks: [
      'Lire votre histoire',
      'La partager avec la famille ou les amis',
      "Modifier ou ajuster l'histoire si vous souhaitez des changements",
      'Commander un livre imprimé',
      'Télécharger en PDF',
    ],
    signoff: "Merci d'utiliser MagicalStory !",
  },
  it: {
    subject: 'La tua storia magica "{title}" è pronta!',
    preview: 'La tua storia personalizzata è pronta — guarda, ordina come libro stampato o scarica in PDF.',
    headline: 'La tua storia è pronta!',
    greeting: 'Ciao {greeting},',
    body: 'Buone notizie! La tua storia personalizzata "{title}" è stata creata e ti aspetta.',
    cta: 'Vedi la tua storia',
    perksIntro: 'Ora puoi:',
    perks: [
      'Leggere la tua storia',
      'Condividerla con la famiglia o gli amici',
      'Modificare o adattare la storia se desideri dei cambiamenti',
      'Ordinarla come libro stampato',
      'Scaricarla in PDF',
    ],
    signoff: 'Grazie per aver usato MagicalStory!',
  },
};

// ─── story-failed ────────────────────────────────────────────────────────────
// Placeholders: {greeting}.
export const storyFailed: Record<Lang, {
  subject: string; preview: string; headline: string; greeting: string;
  body: string; warnLine: string; cta: string; apology: string; signoff: string;
}> = {
  en: {
    subject: 'We encountered an issue with your story',
    preview: 'A problem came up while creating your story — our team has been notified.',
    headline: 'Something went wrong',
    greeting: 'Hello {greeting},',
    body: "We're sorry, but we encountered a problem while creating your story. Our team has been notified and is looking into it. You can try again now, or contact us if the problem persists.",
    warnLine: 'No credits were spent on this attempt.',
    cta: 'Try again',
    apology: 'We apologize for any inconvenience.',
    signoff: 'Best regards,\nThe MagicalStory Team',
  },
  de: {
    subject: 'Bei deiner Geschichte ist ein Problem aufgetreten',
    preview: 'Bei der Erstellung deiner Geschichte gab es ein Problem — unser Team wurde informiert.',
    headline: 'Etwas ist schiefgelaufen',
    greeting: 'Hallo {greeting},',
    body: 'Es tut uns leid, aber bei der Erstellung deiner Geschichte ist ein Problem aufgetreten. Unser Team wurde benachrichtigt und untersucht das Problem. Du kannst es jetzt nochmals versuchen oder uns kontaktieren, wenn es weiterhin besteht.',
    warnLine: 'Für diesen Versuch wurden keine Credits abgezogen.',
    cta: 'Nochmal versuchen',
    apology: 'Wir entschuldigen uns für die Unannehmlichkeiten.',
    signoff: 'Mit freundlichen Grüssen,\nDas MagicalStory Team',
  },
  fr: {
    subject: 'Un problème est survenu avec votre histoire',
    preview: 'Un problème est survenu lors de la création de votre histoire — notre équipe a été informée.',
    headline: 'Quelque chose s\'est mal passé',
    greeting: 'Bonjour {greeting},',
    body: "Nous sommes désolés, mais nous avons rencontré un problème lors de la création de votre histoire. Notre équipe a été informée et examine la situation. Vous pouvez réessayer maintenant ou nous contacter si le problème persiste.",
    warnLine: "Aucun crédit n'a été utilisé pour cette tentative.",
    cta: 'Réessayer',
    apology: 'Nous nous excusons pour la gêne occasionnée.',
    signoff: "Cordialement,\nL'équipe MagicalStory",
  },
  it: {
    subject: "C'è stato un problema con la tua storia",
    preview: 'Si è verificato un problema durante la creazione della tua storia — il nostro team è stato avvisato.',
    headline: 'Qualcosa è andato storto',
    greeting: 'Ciao {greeting},',
    body: 'Ci dispiace, ma abbiamo avuto un problema nella creazione della tua storia. Il nostro team è stato avvisato e sta esaminando la questione. Puoi riprovare ora o contattarci se il problema persiste.',
    warnLine: 'Nessun credito è stato utilizzato per questo tentativo.',
    cta: 'Riprova',
    apology: 'Ci scusiamo per il disagio.',
    signoff: 'Cari saluti,\nIl team di MagicalStory',
  },
};

// ─── trial-story-complete ────────────────────────────────────────────────────
// Sent when a trial (anonymous) user's first story is ready. PDF attached.
// Placeholders: {greeting}, {title}, {claimUrl}, {credits}, {?coverUrl}{/coverUrl}.
export const trialStoryComplete: Record<Lang, {
  subject: string; preview: string; headline: string; greeting: string;
  body: string; attachmentNote: string; claimLine: string; cta: string;
  perksIntro: string; perks: string[]; signoff: string;
}> = {
  en: {
    subject: 'Your magical story "{title}" is ready!',
    preview: 'Your trial story is ready and attached as a PDF. Claim your account to keep it.',
    headline: 'Your story is ready!',
    greeting: 'Hello {greeting},',
    body: 'Great news! Your personalized story "{title}" has been created.',
    attachmentNote: 'The story PDF is attached to this email so you can enjoy it right away.',
    claimLine: 'Set your password to unlock {credits} free credits — enough to create one more full story, free.',
    cta: 'Claim your free story',
    perksIntro: 'With a full account you also unlock:',
    perks: [
      'Multiple characters in one story',
      'Longer stories',
      'Multiple drawing styles',
      'Higher image quality and title page',
      'Available as a printed book',
    ],
    signoff: 'Thank you for trying MagicalStory!',
  },
  de: {
    subject: 'Deine magische Geschichte "{title}" ist fertig!',
    preview: 'Deine Probe-Geschichte ist fertig und als PDF angehängt. Aktiviere dein Konto, um sie zu behalten.',
    headline: 'Deine Geschichte ist fertig!',
    greeting: 'Hallo {greeting},',
    body: 'Tolle Neuigkeiten! Deine personalisierte Geschichte "{title}" wurde erstellt.',
    attachmentNote: 'Das PDF der Geschichte ist dieser E-Mail angehängt, damit du sie sofort lesen kannst.',
    claimLine: 'Setze dein Passwort und erhalte {credits} Gratis-Credits — genug für eine weitere komplette Geschichte, gratis.',
    cta: 'Gratis-Geschichte sichern',
    perksIntro: 'Mit einem vollständigen Konto erhältst du ausserdem:',
    perks: [
      'Mehrere Figuren in einer Geschichte',
      'Längere Geschichten',
      'Verschiedene Zeichenstile',
      'Höhere Bildqualität und Titelseite',
      'Bestellbar als gedrucktes Buch',
    ],
    signoff: 'Vielen Dank, dass du MagicalStory ausprobiert hast!',
  },
  fr: {
    subject: 'Votre histoire magique "{title}" est prête !',
    preview: 'Votre histoire d\'essai est prête et jointe en PDF. Activez votre compte pour la conserver.',
    headline: 'Votre histoire est prête !',
    greeting: 'Bonjour {greeting},',
    body: 'Bonne nouvelle ! Votre histoire personnalisée "{title}" a été créée.',
    attachmentNote: "Le PDF de l'histoire est joint à cet e-mail pour que vous puissiez en profiter immédiatement.",
    claimLine: 'Définissez votre mot de passe et débloquez {credits} crédits gratuits — de quoi créer une histoire complète de plus, gratuitement.',
    cta: 'Réclamer mon histoire gratuite',
    perksIntro: 'Avec un compte complet, vous débloquez aussi :',
    perks: [
      'Plusieurs personnages dans une même histoire',
      'Des histoires plus longues',
      'Plusieurs styles de dessin',
      "Qualité d'image supérieure et page de titre",
      'Disponible en livre imprimé',
    ],
    signoff: "Merci d'avoir essayé MagicalStory !",
  },
  it: {
    subject: 'La tua storia magica "{title}" è pronta!',
    preview: 'La tua storia di prova è pronta e allegata in PDF. Attiva il tuo account per conservarla.',
    headline: 'La tua storia è pronta!',
    greeting: 'Ciao {greeting},',
    body: 'Buone notizie! La tua storia personalizzata "{title}" è stata creata.',
    attachmentNote: "Il PDF della storia è allegato a questa e-mail, così puoi leggerla subito.",
    claimLine: "Imposta la tua password e sblocca {credits} crediti gratuiti — abbastanza per creare un'altra storia completa, gratis.",
    cta: 'Sblocca la mia storia gratuita',
    perksIntro: 'Con un account completo sblocchi anche:',
    perks: [
      'Più personaggi in una sola storia',
      'Storie più lunghe',
      'Diversi stili di disegno',
      "Qualità d'immagine superiore e copertina con titolo",
      'Disponibile come libro stampato',
    ],
    signoff: 'Grazie per aver provato MagicalStory!',
  },
};

// ─── trial-reminder ──────────────────────────────────────────────────────────
// Variant copy ({subject}, {headline}, {body}, {ctaLabel}, {perksIntro}) is
// computed in email.js per send (day-5 vs day-25). The template only owns the
// static intro greeting + the perks bullet list + signoff per language.
// Placeholders: {greeting}, {claimUrl}, {subject}, {headline}, {body},
// {ctaLabel}, {perksIntro}, {credits}, {daysLeft}.
export const trialReminder: Record<Lang, {
  preview: string; greeting: string; perks: string[]; signoff: string;
}> = {
  en: {
    preview: 'Your free credits are still waiting — claim your account to keep them.',
    greeting: 'Hello {greeting},',
    perks: [
      'Multiple characters in one story',
      'Longer stories',
      'Multiple drawing styles',
      'Higher image quality and title page',
      'Available as a printed book',
    ],
    signoff: 'Thank you for trying MagicalStory!',
  },
  de: {
    preview: 'Deine Gratis-Credits warten noch — aktiviere dein Konto, um sie zu sichern.',
    greeting: 'Hallo {greeting},',
    perks: [
      'Mehrere Figuren in einer Geschichte',
      'Längere Geschichten',
      'Verschiedene Zeichenstile',
      'Höhere Bildqualität und Titelseite',
      'Bestellbar als gedrucktes Buch',
    ],
    signoff: 'Vielen Dank, dass du MagicalStory ausprobiert hast!',
  },
  fr: {
    preview: 'Vos crédits gratuits vous attendent toujours — activez votre compte pour les conserver.',
    greeting: 'Bonjour {greeting},',
    perks: [
      'Plusieurs personnages dans une même histoire',
      'Des histoires plus longues',
      'Plusieurs styles de dessin',
      "Qualité d'image supérieure et page de titre",
      'Disponible en livre imprimé',
    ],
    signoff: "Merci d'avoir essayé MagicalStory !",
  },
  it: {
    preview: 'I tuoi crediti gratuiti ti aspettano ancora — attiva il tuo account per conservarli.',
    greeting: 'Ciao {greeting},',
    perks: [
      'Più personaggi in una sola storia',
      'Storie più lunghe',
      'Diversi stili di disegno',
      "Qualità d'immagine superiore e copertina con titolo",
      'Disponibile come libro stampato',
    ],
    signoff: 'Grazie per aver provato MagicalStory!',
  },
};

// ─── order-confirmation ──────────────────────────────────────────────────────
// Placeholders: {greeting}, {orderId}, {amount}, {currency}, {addressLine1},
//   {city}, {postalCode}, {country}, {deliveryEstimate}, {?coverUrl}{/coverUrl}.
export const orderConfirmation: Record<Lang, {
  subject: string; preview: string; headline: string; greeting: string;
  body: string; detailsTitle: string; labelOrderId: string; labelAmount: string;
  labelShipping: string; labelDelivery: string; followUp: string; signoff: string;
}> = {
  en: {
    subject: 'Order confirmed — your MagicalStory book is being printed!',
    preview: 'Your order is confirmed. We\'ll email you again when it ships.',
    headline: 'Your book is being printed',
    greeting: 'Hello {greeting},',
    body: 'Thank you for your order! Your personalized storybook is now being printed.',
    detailsTitle: 'Order details',
    labelOrderId: 'Order ID',
    labelAmount: 'Amount',
    labelShipping: 'Shipping to',
    labelDelivery: 'Estimated delivery',
    followUp: "You'll receive another email when your book ships with tracking information.",
    signoff: 'Thank you for choosing MagicalStory!',
  },
  de: {
    subject: 'Bestellung bestätigt — dein MagicalStory Buch wird gedruckt!',
    preview: 'Deine Bestellung ist bestätigt. Wir melden uns wieder, sobald sie versandt wird.',
    headline: 'Dein Buch wird gedruckt',
    greeting: 'Hallo {greeting},',
    body: 'Vielen Dank für deine Bestellung! Dein personalisiertes Geschichtenbuch wird jetzt gedruckt.',
    detailsTitle: 'Bestelldetails',
    labelOrderId: 'Bestellnummer',
    labelAmount: 'Betrag',
    labelShipping: 'Lieferadresse',
    labelDelivery: 'Voraussichtliche Lieferung',
    followUp: 'Du erhältst eine weitere E-Mail mit Tracking-Informationen, sobald dein Buch versandt wird.',
    signoff: 'Vielen Dank, dass du MagicalStory gewählt hast!',
  },
  fr: {
    subject: 'Commande confirmée — votre livre MagicalStory est en cours d\'impression !',
    preview: 'Votre commande est confirmée. Nous vous écrirons à nouveau lors de l\'expédition.',
    headline: 'Votre livre est en cours d\'impression',
    greeting: 'Bonjour {greeting},',
    body: "Merci pour votre commande ! Votre livre d'histoires personnalisé est en cours d'impression.",
    detailsTitle: 'Détails de la commande',
    labelOrderId: 'Numéro de commande',
    labelAmount: 'Montant',
    labelShipping: 'Adresse de livraison',
    labelDelivery: 'Délai de livraison estimé',
    followUp: 'Vous recevrez un autre e-mail avec les informations de suivi lorsque votre livre sera expédié.',
    signoff: "Merci d'avoir choisi MagicalStory !",
  },
  it: {
    subject: 'Ordine confermato — il tuo libro MagicalStory è in stampa!',
    preview: 'Il tuo ordine è confermato. Ti scriveremo di nuovo al momento della spedizione.',
    headline: 'Il tuo libro è in stampa',
    greeting: 'Ciao {greeting},',
    body: 'Grazie per il tuo ordine! Il tuo libro di storie personalizzato è in stampa.',
    detailsTitle: "Dettagli dell'ordine",
    labelOrderId: "Numero d'ordine",
    labelAmount: 'Importo',
    labelShipping: 'Indirizzo di consegna',
    labelDelivery: 'Tempo di consegna stimato',
    followUp: "Riceverai un'altra e-mail con le informazioni di tracciamento quando il libro sarà spedito.",
    signoff: 'Grazie per aver scelto MagicalStory!',
  },
};

// ─── order-shipped ───────────────────────────────────────────────────────────
// Placeholders: {greeting}, {orderId}, {trackingNumber}, {trackingUrl},
//   {?coverUrl}{/coverUrl}.
export const orderShipped: Record<Lang, {
  subject: string; preview: string; headline: string; greeting: string;
  body: string; trackingTitle: string; labelOrderId: string;
  labelTracking: string; cta: string; closing: string;
  reviewPrompt: string; signoff: string;
}> = {
  en: {
    subject: 'Your MagicalStory book has shipped!',
    preview: 'Your personalized storybook is on its way — track it here.',
    headline: 'Your book is on its way',
    greeting: 'Hello {greeting},',
    body: 'Great news! Your personalized storybook is on its way.',
    trackingTitle: 'Tracking information',
    labelOrderId: 'Order ID',
    labelTracking: 'Tracking number',
    cta: 'Track your package',
    closing: 'Your book should arrive within the next few days. We hope you love it!',
    reviewPrompt: "How was your experience? We'd love to hear from you.",
    signoff: 'Thank you for choosing MagicalStory!',
  },
  de: {
    subject: 'Dein MagicalStory Buch ist unterwegs!',
    preview: 'Dein personalisiertes Geschichtenbuch ist auf dem Weg — Sendung verfolgen.',
    headline: 'Dein Buch ist unterwegs',
    greeting: 'Hallo {greeting},',
    body: 'Tolle Neuigkeiten! Dein personalisiertes Geschichtenbuch ist auf dem Weg.',
    trackingTitle: 'Sendungsverfolgung',
    labelOrderId: 'Bestellnummer',
    labelTracking: 'Sendungsnummer',
    cta: 'Sendung verfolgen',
    closing: 'Dein Buch sollte in den nächsten Tagen ankommen. Wir hoffen, es gefällt dir!',
    reviewPrompt: 'Wie war dein Erlebnis? Wir freuen uns über dein Feedback.',
    signoff: 'Vielen Dank, dass du MagicalStory gewählt hast!',
  },
  fr: {
    subject: 'Votre livre MagicalStory est en route !',
    preview: 'Votre livre personnalisé est en route — suivez son acheminement.',
    headline: 'Votre livre est en route',
    greeting: 'Bonjour {greeting},',
    body: "Bonne nouvelle ! Votre livre d'histoires personnalisé est en route.",
    trackingTitle: 'Informations de suivi',
    labelOrderId: 'Numéro de commande',
    labelTracking: 'Numéro de suivi',
    cta: 'Suivre votre colis',
    closing: 'Votre livre devrait arriver dans les prochains jours. Nous espérons qu\'il vous plaira !',
    reviewPrompt: "Comment était votre expérience ? Nous serions ravis d'avoir votre avis.",
    signoff: "Merci d'avoir choisi MagicalStory !",
  },
  it: {
    subject: 'Il tuo libro MagicalStory è in viaggio!',
    preview: 'Il tuo libro personalizzato è in viaggio — seguilo qui.',
    headline: 'Il tuo libro è in viaggio',
    greeting: 'Ciao {greeting},',
    body: 'Buone notizie! Il tuo libro di storie personalizzato è in viaggio.',
    trackingTitle: 'Informazioni di tracciamento',
    labelOrderId: "Numero d'ordine",
    labelTracking: 'Numero di tracciamento',
    cta: 'Segui il tuo pacco',
    closing: 'Il tuo libro dovrebbe arrivare nei prossimi giorni. Speriamo ti piaccia!',
    reviewPrompt: "Com'è stata la tua esperienza? Ci piacerebbe sapere cosa ne pensi.",
    signoff: 'Grazie per aver scelto MagicalStory!',
  },
};

// ─── order-failed ────────────────────────────────────────────────────────────
// Placeholders: {greeting}.
export const orderFailed: Record<Lang, {
  subject: string; preview: string; headline: string; greeting: string;
  body: string; reassurance: string; questions: string; signoff: string;
}> = {
  en: {
    subject: "Order issue — we're on it",
    preview: 'A technical issue interrupted your book order. We are on it; no action needed.',
    headline: "We're on it",
    greeting: 'Dear {greeting},',
    body: 'Unfortunately, a technical issue occurred while processing your book order. Our team has been automatically notified and is working on a resolution.',
    reassurance: "No action is needed from you — we'll reach out once the issue is resolved. If a refund is necessary, we will process it for you.",
    questions: 'For questions: info@magicalstory.ch',
    signoff: 'MagicalStory Team',
  },
  de: {
    subject: 'Bestellproblem — wir kümmern uns darum',
    preview: 'Ein technisches Problem hat deine Buchbestellung unterbrochen. Wir kümmern uns darum.',
    headline: 'Wir kümmern uns darum',
    greeting: 'Liebe/r {greeting},',
    body: 'Bei der Verarbeitung deiner Buchbestellung ist leider ein technisches Problem aufgetreten. Unser Team wurde automatisch benachrichtigt und kümmert sich um die Lösung.',
    reassurance: 'Du musst nichts weiter tun — wir melden uns bei dir, sobald das Problem behoben ist. Sollte eine Rückerstattung nötig sein, werden wir diese veranlassen.',
    questions: 'Bei Fragen: info@magicalstory.ch',
    signoff: 'MagicalStory Team',
  },
  fr: {
    subject: 'Problème de commande — nous nous en occupons',
    preview: 'Un problème technique a interrompu votre commande. Nous nous en occupons, aucune action requise.',
    headline: 'Nous nous en occupons',
    greeting: 'Cher/Chère {greeting},',
    body: "Malheureusement, un problème technique est survenu lors du traitement de votre commande de livre. Notre équipe a été automatiquement informée et travaille à la résolution du problème.",
    reassurance: "Aucune action n'est requise de votre part — nous vous contacterons dès que le problème sera résolu. Si un remboursement est nécessaire, nous le traiterons pour vous.",
    questions: 'Pour toute question : info@magicalstory.ch',
    signoff: "L'équipe MagicalStory",
  },
  it: {
    subject: 'Problema con il tuo ordine — ce ne stiamo occupando',
    preview: "Un problema tecnico ha interrotto il tuo ordine. Ce ne stiamo occupando, nessuna azione richiesta.",
    headline: 'Ce ne stiamo occupando',
    greeting: 'Caro/Cara {greeting},',
    body: "Purtroppo si è verificato un problema tecnico durante l'elaborazione del tuo ordine. Il nostro team è stato avvisato automaticamente e sta lavorando per risolverlo.",
    reassurance: 'Non devi fare nulla — ti contatteremo non appena il problema sarà risolto. Se sarà necessario un rimborso, lo elaboreremo per te.',
    questions: 'Per qualsiasi domanda: info@magicalstory.ch',
    signoff: 'Il team di MagicalStory',
  },
};

// ─── email-verification ──────────────────────────────────────────────────────
// Placeholders: {verifyUrl}.
export const emailVerification: Record<Lang, {
  subject: string; preview: string; headline: string; body: string;
  cta: string; expires: string; ignoreLine: string;
}> = {
  en: {
    subject: 'Verify your MagicalStory email address',
    preview: 'Confirm your email address to finish creating your MagicalStory account.',
    headline: 'Verify your email',
    body: 'Please verify your email address by clicking the button below.',
    cta: 'Verify email address',
    expires: 'This link expires in 24 hours.',
    ignoreLine: "If you didn't create a MagicalStory account, you can safely ignore this email.",
  },
  de: {
    subject: 'Bestätige deine MagicalStory E-Mail-Adresse',
    preview: 'Bestätige deine E-Mail-Adresse, um die Einrichtung deines Kontos abzuschliessen.',
    headline: 'Bestätige deine E-Mail-Adresse',
    body: 'Bitte bestätige deine E-Mail-Adresse, indem du auf den Button unten klickst.',
    cta: 'E-Mail-Adresse bestätigen',
    expires: 'Dieser Link ist 24 Stunden gültig.',
    ignoreLine: 'Falls du kein MagicalStory-Konto erstellt hast, kannst du diese E-Mail ignorieren.',
  },
  fr: {
    subject: 'Vérifiez votre adresse e-mail MagicalStory',
    preview: 'Confirmez votre adresse e-mail pour finaliser la création de votre compte.',
    headline: 'Vérifiez votre adresse e-mail',
    body: 'Veuillez vérifier votre adresse e-mail en cliquant sur le bouton ci-dessous.',
    cta: 'Vérifier mon adresse e-mail',
    expires: 'Ce lien expire dans 24 heures.',
    ignoreLine: "Si vous n'avez pas créé de compte MagicalStory, vous pouvez ignorer cet e-mail.",
  },
  it: {
    subject: 'Verifica il tuo indirizzo e-mail MagicalStory',
    preview: 'Conferma il tuo indirizzo e-mail per completare la creazione del tuo account.',
    headline: 'Verifica il tuo indirizzo e-mail',
    body: 'Verifica il tuo indirizzo e-mail cliccando sul pulsante qui sotto.',
    cta: "Verifica l'indirizzo e-mail",
    expires: 'Questo link scade dopo 24 ore.',
    ignoreLine: 'Se non hai creato un account MagicalStory, puoi ignorare questa e-mail.',
  },
};

// ─── password-reset ──────────────────────────────────────────────────────────
// Placeholders: {resetUrl}.
export const passwordReset: Record<Lang, {
  subject: string; preview: string; headline: string; body: string;
  cta: string; expires: string; ignoreLine: string;
}> = {
  en: {
    subject: 'Reset your MagicalStory password',
    preview: 'Set a new password for your MagicalStory account.',
    headline: 'Reset your password',
    body: 'You requested to reset your password. Click the button below to set a new one.',
    cta: 'Reset password',
    expires: 'This link expires in 1 hour.',
    ignoreLine: "If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.",
  },
  de: {
    subject: 'Setze dein MagicalStory-Passwort zurück',
    preview: 'Lege ein neues Passwort für dein MagicalStory-Konto fest.',
    headline: 'Passwort zurücksetzen',
    body: 'Du hast eine Passwortzurücksetzung angefordert. Klicke auf den Button unten, um ein neues Passwort festzulegen.',
    cta: 'Passwort zurücksetzen',
    expires: 'Dieser Link ist 1 Stunde gültig.',
    ignoreLine: 'Falls du keine Passwortzurücksetzung angefordert hast, kannst du diese E-Mail ignorieren. Dein Passwort wird nicht geändert.',
  },
  fr: {
    subject: 'Réinitialiser votre mot de passe MagicalStory',
    preview: 'Définissez un nouveau mot de passe pour votre compte MagicalStory.',
    headline: 'Réinitialiser votre mot de passe',
    body: 'Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour en définir un nouveau.',
    cta: 'Réinitialiser le mot de passe',
    expires: 'Ce lien expire dans 1 heure.',
    ignoreLine: "Si vous n'avez pas demandé de réinitialisation de mot de passe, vous pouvez ignorer cet e-mail. Votre mot de passe ne sera pas modifié.",
  },
  it: {
    subject: 'Reimposta la tua password MagicalStory',
    preview: 'Imposta una nuova password per il tuo account MagicalStory.',
    headline: 'Reimposta la tua password',
    body: 'Hai richiesto la reimpostazione della tua password. Clicca sul pulsante qui sotto per impostarne una nuova.',
    cta: 'Reimposta password',
    expires: 'Questo link scade dopo 1 ora.',
    ignoreLine: 'Se non hai richiesto la reimpostazione della password, puoi ignorare questa e-mail. La tua password non verrà modificata.',
  },
};
