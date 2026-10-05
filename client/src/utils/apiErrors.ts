// Localised text for failed API calls. The server keeps English `error` strings for logs and
// sends a stable `code` where the client needs to tell failures apart (services/api.ts copies
// both `code` and `status` onto the thrown Error). Customers never see the raw English text:
// code -> status -> caller's own localised fallback -> generic localised message.

type Table = Record<string, string>;
type Lang = 'en' | 'de' | 'fr' | 'it';

const t = (en: string, de: string, fr: string, it: string): Table => ({ en, de, fr, it });

/** Stable server `code` -> message. Add a row here whenever a route gets a new code the UI must explain. */
const BY_CODE: Record<string, Table> = {
  INVALID_FORM: t('Please wait a few seconds and try again.', 'Bitte warte ein paar Sekunden und versuche es erneut.', 'Veuillez patienter quelques secondes et réessayer.', 'Attendi qualche secondo e riprova.'),
  TOO_FAST: t('Please wait a few seconds and try again.', 'Bitte warte ein paar Sekunden und versuche es erneut.', 'Veuillez patienter quelques secondes et réessayer.', 'Attendi qualche secondo e riprova.'),
  EMAIL_ALREADY_REGISTERED: t('This email address is already registered.', 'Diese E-Mail-Adresse ist bereits registriert.', 'Cette adresse e-mail est déjà enregistrée.', 'Questo indirizzo e-mail è già registrato.'),
  EMAIL_EXISTS: t('An account with this email address already exists.', 'Mit dieser E-Mail-Adresse gibt es bereits ein Konto.', 'Un compte existe déjà avec cette adresse e-mail.', 'Esiste già un account con questo indirizzo e-mail.'),
  EMAIL_NOT_REGISTERED: t('No account exists for this email address.', 'Zu dieser E-Mail-Adresse gibt es kein Konto.', 'Aucun compte n’existe pour cette adresse e-mail.', 'Non esiste un account per questo indirizzo e-mail.'),
  CREDENTIALS_REQUIRED: t('Please fill in all required fields.', 'Bitte fülle alle Pflichtfelder aus.', 'Veuillez remplir tous les champs obligatoires.', 'Compila tutti i campi obbligatori.'),
  INVALID_CREDENTIALS: t('The email address or password is incorrect.', 'E-Mail-Adresse oder Passwort ist falsch.', 'L’adresse e-mail ou le mot de passe est incorrect.', 'Indirizzo e-mail o password errati.'),
  RESET_TOKEN_INVALID: t('This reset link is invalid or has expired. Please request a new one.', 'Dieser Link zum Zurücksetzen ist ungültig oder abgelaufen. Bitte fordere einen neuen an.', 'Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.', 'Questo link di reimpostazione non è valido o è scaduto. Richiedine uno nuovo.'),
  GOOGLE_ACCOUNT_NO_PASSWORD: t('Accounts that sign in with Google have no password to change.', 'Konten mit Google-Anmeldung haben kein Passwort, das du ändern könntest.', 'Les comptes connectés avec Google n’ont pas de mot de passe à modifier.', 'Gli account con accesso Google non hanno una password da modificare.'),
  NO_PASSWORD_SET: t('No password is set yet. Sign in with Google or set a password first.', 'Es ist noch kein Passwort festgelegt. Melde dich mit Google an oder lege zuerst ein Passwort fest.', 'Aucun mot de passe n’est encore défini. Connectez-vous avec Google ou définissez d’abord un mot de passe.', 'Non è ancora impostata alcuna password. Accedi con Google o imposta prima una password.'),
  CURRENT_PASSWORD_INCORRECT: t('The current password is incorrect.', 'Das aktuelle Passwort ist falsch.', 'Le mot de passe actuel est incorrect.', 'La password attuale non è corretta.'),
  PASSWORD_LENGTH: t('The password must be between 8 and 128 characters long.', 'Das Passwort muss zwischen 8 und 128 Zeichen lang sein.', 'Le mot de passe doit contenir entre 8 et 128 caractères.', 'La password deve contenere da 8 a 128 caratteri.'),
  PASSWORD_ALREADY_SET: t('A password is already set. Please change it instead.', 'Es ist bereits ein Passwort festgelegt. Bitte ändere es stattdessen.', 'Un mot de passe est déjà défini. Veuillez plutôt le modifier.', 'Una password è già impostata. Modificala invece.'),
  VERIFICATION_COOLDOWN: t('Please wait a moment before requesting another verification email.', 'Bitte warte einen Moment, bevor du eine weitere Bestätigungs-E-Mail anforderst.', 'Veuillez patienter un instant avant de demander un nouvel e-mail de confirmation.', 'Attendi un momento prima di richiedere un’altra e-mail di conferma.'),
  EMAIL_SERVICE_UNAVAILABLE: t('The email could not be sent right now. Please try again later.', 'Die E-Mail konnte gerade nicht gesendet werden. Bitte versuche es später erneut.', 'L’e-mail n’a pas pu être envoyé pour le moment. Veuillez réessayer plus tard.', 'Al momento non è stato possibile inviare l’e-mail. Riprova più tardi.'),
  VERIFICATION_EXPIRED: t('The verification link has expired. Please register again.', 'Der Bestätigungslink ist abgelaufen. Bitte registriere dich erneut.', 'Le lien de confirmation a expiré. Veuillez vous inscrire à nouveau.', 'Il link di conferma è scaduto. Registrati di nuovo.'),
  INVALID_EMAIL: t('Please enter a valid email address.', 'Bitte gib eine gültige E-Mail-Adresse ein.', 'Veuillez saisir une adresse e-mail valide.', 'Inserisci un indirizzo e-mail valido.'),
  EMAIL_REQUIRED: t('Please enter your email address.', 'Bitte gib deine E-Mail-Adresse ein.', 'Veuillez saisir votre adresse e-mail.', 'Inserisci il tuo indirizzo e-mail.'),
  EMAIL_REQUIRED_FIRST: t('Please confirm an email address before setting a password.', 'Bitte bestätige zuerst eine E-Mail-Adresse, bevor du ein Passwort festlegst.', 'Veuillez d’abord confirmer une adresse e-mail avant de définir un mot de passe.', 'Conferma prima un indirizzo e-mail, poi imposta una password.'),
  EMAIL_ALREADY_VERIFIED: t('This email address is already verified.', 'Diese E-Mail-Adresse ist bereits bestätigt.', 'Cette adresse e-mail est déjà confirmée.', 'Questo indirizzo e-mail è già confermato.'),
  EMAIL_NOT_VERIFIED: t('This email address is not verified yet.', 'Diese E-Mail-Adresse ist noch nicht bestätigt.', 'Cette adresse e-mail n’est pas encore confirmée.', 'Questo indirizzo e-mail non è ancora confermato.'),
  GOOGLE_TOKEN_EXPIRED: t('Your Google sign-in has expired. Please sign in again.', 'Deine Google-Anmeldung ist abgelaufen. Bitte melde dich erneut an.', 'Votre connexion Google a expiré. Veuillez vous reconnecter.', 'L’accesso con Google è scaduto. Accedi di nuovo.'),
  GOOGLE_EMAIL_UNVERIFIED: t('Google has not verified this email address.', 'Google hat diese E-Mail-Adresse nicht bestätigt.', 'Google n’a pas confirmé cette adresse e-mail.', 'Google non ha confermato questo indirizzo e-mail.'),
  TRIAL_USED: t('The free trial story has already been used.', 'Die kostenlose Probegeschichte wurde bereits verwendet.', 'L’histoire d’essai gratuite a déjà été utilisée.', 'La storia di prova gratuita è già stata utilizzata.'),
  TRIAL_LIMIT_REACHED: t('Too many attempts. Please try again tomorrow.', 'Zu viele Versuche. Bitte versuche es morgen erneut.', 'Trop de tentatives. Veuillez réessayer demain.', 'Troppi tentativi. Riprova domani.'),
  TRIAL_SESSION_EXPIRED: t('Your session has expired. Please start over.', 'Deine Sitzung ist abgelaufen. Bitte starte neu.', 'Votre session a expiré. Veuillez recommencer.', 'La sessione è scaduta. Ricomincia da capo.'),
  TEMPORARILY_UNAVAILABLE: t('The service is temporarily unavailable. Please try again in a moment.', 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuche es gleich noch einmal.', 'Le service est temporairement indisponible. Veuillez réessayer dans un instant.', 'Il servizio è temporaneamente non disponibile. Riprova tra un momento.'),
  DAILY_CAPACITY_REACHED: t('The service is at capacity for today. Please try again tomorrow.', 'Der Dienst ist für heute ausgelastet. Bitte versuche es morgen erneut.', 'Le service est complet pour aujourd’hui. Veuillez réessayer demain.', 'Il servizio ha raggiunto la capacità per oggi. Riprova domani.'),
  TURNSTILE_FAILED: t('The security check failed. Please try again.', 'Die Sicherheitsprüfung ist fehlgeschlagen. Bitte versuche es erneut.', 'La vérification de sécurité a échoué. Veuillez réessayer.', 'Il controllo di sicurezza non è riuscito. Riprova.'),
  NAME_AND_PHOTO_REQUIRED: t('Please enter a name and add a photo.', 'Bitte gib einen Namen ein und füge ein Foto hinzu.', 'Veuillez saisir un nom et ajouter une photo.', 'Inserisci un nome e aggiungi una foto.'),
  INVALID_NAME: t('Please check the name.', 'Bitte überprüfe den Namen.', 'Veuillez vérifier le nom.', 'Controlla il nome.'),
  INVALID_GENDER: t('Please check the gender.', 'Bitte überprüfe das Geschlecht.', 'Veuillez vérifier le genre.', 'Controlla il genere.'),
  INVALID_AGE: t('Please check the age.', 'Bitte überprüfe das Alter.', 'Veuillez vérifier l’âge.', 'Controlla l’età.'),
  PHOTO_UNPROCESSABLE: t('The photo could not be processed. Please try a different photo.', 'Das Foto konnte nicht verarbeitet werden. Bitte versuche ein anderes Foto.', 'La photo n’a pas pu être traitée. Veuillez essayer une autre photo.', 'Non è stato possibile elaborare la foto. Prova con un’altra foto.'),
  AVATAR_FAILED: t('The avatar could not be created. Please try again.', 'Der Avatar konnte nicht erstellt werden. Bitte versuche es erneut.', 'L’avatar n’a pas pu être créé. Veuillez réessayer.', 'Non è stato possibile creare l’avatar. Riprova.'),
  ACCOUNT_NOT_FOUND: t('Account not found. Please start over.', 'Konto nicht gefunden. Bitte starte neu.', 'Compte introuvable. Veuillez recommencer.', 'Account non trovato. Ricomincia da capo.'),
  CHARACTER_NOT_FOUND: t('Character not found. Please start over.', 'Figur nicht gefunden. Bitte starte neu.', 'Personnage introuvable. Veuillez recommencer.', 'Personaggio non trovato. Ricomincia da capo.'),
  TOO_MANY_CHARACTERS: t('A story can have at most 10 characters. Set some characters to "Out".', 'Eine Geschichte kann höchstens 10 Figuren haben. Setze einige Figuren auf «Nicht dabei».', 'Une histoire peut avoir au maximum 10 personnages. Mettez des personnages sur « Absent ».', 'Una storia può avere al massimo 10 personaggi. Imposta alcuni personaggi su «Assente».'),
  TOPIC_REQUIRED: t('Please enter a story topic.', 'Bitte gib ein Thema für die Geschichte ein.', 'Veuillez saisir un thème pour l’histoire.', 'Inserisci un tema per la storia.'),
  INSUFFICIENT_REFERRAL_BALANCE: t('Your referral balance is not sufficient for this.', 'Dein Empfehlungsguthaben reicht dafür nicht aus.', 'Votre solde de parrainage ne suffit pas.', 'Il tuo saldo di segnalazione non è sufficiente.'),
  REFERRAL_BALANCE_CHANGED: t('Your referral balance has changed. Please try the checkout again.', 'Dein Empfehlungsguthaben hat sich geändert. Bitte starte die Bestellung erneut.', 'Votre solde de parrainage a changé. Veuillez relancer la commande.', 'Il tuo saldo di segnalazione è cambiato. Riavvia l’ordine.'),
};

const NETWORK = t('Connection problem. Please check your internet connection and try again.', 'Verbindungsproblem. Bitte überprüfe deine Internetverbindung und versuche es erneut.', 'Problème de connexion. Veuillez vérifier votre connexion Internet et réessayer.', 'Problema di connessione. Controlla la connessione a Internet e riprova.');
const GENERIC = t('Something went wrong. Please try again.', 'Etwas ist schiefgelaufen. Bitte versuche es erneut.', 'Une erreur s’est produite. Veuillez réessayer.', 'Qualcosa è andato storto. Riprova.');
const SERVER = t('Something went wrong on our side. Please try again in a moment.', 'Bei uns ist etwas schiefgelaufen. Bitte versuche es gleich noch einmal.', 'Une erreur est survenue de notre côté. Veuillez réessayer dans un instant.', 'Si è verificato un problema da parte nostra. Riprova tra un momento.');

/** Statuses that carry a meaning the UI can always explain, whatever the route. */
const BY_STATUS: Record<number, Table> = {
  401: t('Please sign in again.', 'Bitte melde dich erneut an.', 'Veuillez vous reconnecter.', 'Accedi di nuovo.'),
  402: t('Not enough credits. Please top up your credits and try again.', 'Dafür reichen deine Credits nicht. Bitte lade Credits auf und versuche es erneut.', 'Vous n’avez pas assez de crédits. Veuillez recharger vos crédits et réessayer.', 'Crediti insufficienti. Ricarica i crediti e riprova.'),
  413: t('The file is too large.', 'Die Datei ist zu gross.', 'Le fichier est trop volumineux.', 'Il file è troppo grande.'),
  429: t('Too many attempts in a short time. Please wait a moment and try again.', 'Zu viele Versuche in kurzer Zeit. Bitte warte einen Moment und versuche es erneut.', 'Trop de tentatives en peu de temps. Veuillez patienter un instant et réessayer.', 'Troppi tentativi in poco tempo. Attendi un momento e riprova.'),
};

const pick = (table: Table, language: string) => table[language as Lang] || table.en;

/**
 * Message for a failed API call, always in the visitor's language. `fallback` is the caller's own
 * already-localised sentence for the action (for example "Login failed"); it is used when neither
 * the code nor the status has a specific message. The raw server text is never returned.
 */
export function localizedApiError(error: unknown, language: string, fallback?: string): string {
  const e = error as { code?: unknown; status?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  if (code && BY_CODE[code]) return pick(BY_CODE[code], language);
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status && BY_STATUS[status]) return pick(BY_STATUS[status], language);
  if (status === undefined && (error instanceof TypeError || (error instanceof Error && /failed to fetch|networkerror/i.test(error.message)))) {
    return pick(NETWORK, language);
  }
  if (fallback) return fallback;
  if (status !== undefined && status >= 500) return pick(SERVER, language);
  return pick(GENERIC, language);
}

/** Codes the table can explain (used by the server-code parity test). */
export const KNOWN_API_ERROR_CODES = Object.keys(BY_CODE);
