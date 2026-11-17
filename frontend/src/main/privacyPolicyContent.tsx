import type { ReactNode } from 'react';
import { COMPANY } from './company';
import { repeatedTestId } from '../testIds';

/*
 * Wording of the privacy policy (German, legally binding version).
 *
 * Keep this in sync with what the application actually does - every new
 * third-party service, cookie/storage key or log must be added here, and
 * material changes need a new PRIVACY_POLICY_LAST_UPDATED (and, if the consent
 * categories change, a CONSENT_VERSION bump in components/privacy/consent.ts).
 */

export const PRIVACY_POLICY_LAST_UPDATED = 'November 2026';

export const CONTROLLER = {
  name: COMPANY.name,
  street: COMPANY.street,
  city: '14979 Großbeeren',
  country: 'Deutschland',
  phone: COMPANY.phone,
  // The privacy contact - not the general one of COMPANY.
  email: 'progeo@progeo.com',
};

export type PolicySection = {
  id: string;
  title: string;
  body: ReactNode;
};

// Every cookie / browser storage key the app sets. Must match the code.
const BROWSER_STORAGE = [
  {
    name: 'csrftoken',
    code: true,
    kind: 'Cookie',
    purpose: 'Schutz vor Cross-Site-Request-Forgery-Angriffen',
    duration: 'bis zu 1 Jahr',
  },
  {
    name: 'sessionid',
    code: true,
    kind: 'Cookie',
    purpose: 'Anmeldesitzung (auch für die Anmeldung im ProGeo Chat)',
    duration: 'bis zur Abmeldung, max. 2 Wochen',
  },
  {
    name: 'authToken',
    code: true,
    kind: 'Local Storage',
    purpose: 'Anmelde-Token für die Kommunikation mit dem Server',
    duration: 'bis zur Abmeldung',
  },
  {
    name: 'refreshToken',
    code: true,
    kind: 'Local Storage',
    purpose: 'Erneuert das Anmelde-Token, ohne dass Sie sich neu anmelden müssen',
    duration: 'bis zur Abmeldung',
  },
  {
    name: 'progeo_consent',
    code: true,
    kind: 'Local Storage',
    purpose: 'Speichert Ihre Datenschutz-Auswahl',
    duration: '12 Monate',
  },
  {
    name: 'i18nextLng',
    code: true,
    kind: 'Local Storage',
    purpose: 'Gewählte Sprache',
    duration: 'bis zur Löschung im Browser',
  },
  {
    name: 'progeo.languageChosen',
    code: true,
    kind: 'Session Storage',
    purpose: 'Auf der Anmeldeseite gewählte Sprache – wird nach der Anmeldung in Ihr Profil übernommen',
    duration: 'bis zur Anmeldung bzw. zum Schließen des Tabs',
  },
  {
    name: 'progeo.sidebar.collapsed, progeo.canvasKeyLegend.collapsed, progeo.map.baseLayer',
    code: true,
    kind: 'Local Storage',
    purpose: 'Darstellung: eingeklappte Seitenleiste bzw. Legende, gewählte Kartenansicht',
    duration: 'bis zur Löschung im Browser',
  },
  {
    name: 'demoToken',
    code: true,
    kind: 'Local Storage',
    purpose: 'Nur öffentliche Demo: erneute Anmeldung über denselben Demo-Link',
    duration: 'bis zum Ablauf des Demo-Links',
  },
  {
    name: 'impersonatorTokens, viewAsUser',
    code: true,
    kind: 'Local Storage',
    purpose: 'Nur für ProGeo-Mitarbeitende: Support-Ansicht („Anmelden als“, „Als Nutzer anzeigen“)',
    duration: 'bis zur Abmeldung',
  },
  {
    name: 'Zwischenspeicher',
    code: false,
    kind: 'Session Storage',
    purpose: 'Beschleunigt das Laden bereits abgerufener Daten',
    duration: 'bis zum Schließen des Tabs',
  },
];

type FactsProps = {
  purpose: ReactNode;
  legalBasis: ReactNode;
  retention: ReactNode;
  recipients?: ReactNode;
  /** The labels in the policy's language (privacyPolicyContentEn.tsx passes the English ones). */
  labels?: FactLabels;
};

export type FactLabels = { purpose: string; legalBasis: string; retention: string; recipients: string };

const FACT_LABELS_DE: FactLabels = {
  purpose: 'Zweck',
  legalBasis: 'Rechtsgrundlage',
  retention: 'Speicherdauer',
  recipients: 'Empfänger',
};

/** Purpose / legal basis / retention block, as required per processing by Art. 13 GDPR. */
export const Facts = ({ purpose, legalBasis, retention, recipients, labels = FACT_LABELS_DE }: FactsProps) => (
  <dl className="privacy-facts">
    <dt>{labels.purpose}</dt>
    <dd>{purpose}</dd>
    <dt>{labels.legalBasis}</dt>
    <dd>{legalBasis}</dd>
    <dt>{labels.retention}</dt>
    <dd>{retention}</dd>
    {recipients && (
      <>
        <dt>{labels.recipients}</dt>
        <dd>{recipients}</dd>
      </>
    )}
  </dl>
);

export const ExternalLink = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => (
  <a href={href} target="_blank" rel="noopener noreferrer" {...repeatedTestId('privacy-policy-external-link', href)}>
    {children}
  </a>
);

export type SectionOptions = {
  /** Rendered inside the "maps" section so revoking consent is one click away. */
  consentButton: ReactNode;
};

export const buildPolicySections = ({
  consentButton,
}: SectionOptions): PolicySection[] => [
  {
    id: 'verantwortlicher',
    title: 'Verantwortlicher',
    body: (
      <>
        <p>
          Verantwortlich für die Verarbeitung personenbezogener Daten in dieser
          Anwendung im Sinne der Datenschutz-Grundverordnung (DSGVO) ist:
        </p>
        <address className="privacy-address">
          <strong>{CONTROLLER.name}</strong>
          <span>{CONTROLLER.street}</span>
          <span>
            {CONTROLLER.city}, {CONTROLLER.country}
          </span>
          <span>Telefon: {CONTROLLER.phone}</span>
          <span>
            E-Mail:{' '}
            <a href={`mailto:${CONTROLLER.email}`} {...repeatedTestId('privacy-policy-mail-link', 'verantwortlicher')}>{CONTROLLER.email}</a>
          </span>
        </address>
        <p>
          Für alle Fragen zum Datenschutz und zur Ausübung Ihrer Rechte
          erreichen Sie uns unter der oben genannten E-Mail-Adresse oder per
          Post mit dem Zusatz „Datenschutz“.
        </p>
      </>
    ),
  },
  {
    id: 'geltungsbereich',
    title: 'Geltungsbereich',
    body: (
      <>
        <p>
          Diese Datenschutzerklärung gilt für das ProGeo-Monitoring-Portal
          (diese Webanwendung) einschließlich der damit verbundenen
          Benachrichtigungen per E-Mail, SMS und Messenger sowie für den
          ProGeo Chat, unseren eigenen Chat-Server. Das Portal dient unseren
          Kundinnen und Kunden zur Überwachung von Gebäuden und Bauwerken,
          insbesondere zur Leckage- und Feuchteortung.
        </p>
        <p>
          Die von unseren Sensoren erfassten Messwerte (z. B. Widerstands- und
          Feuchtewerte) beziehen sich auf Bauwerke und sind in der Regel keine
          personenbezogenen Daten. Personenbezogen sind dagegen insbesondere die
          Daten der Nutzerinnen und Nutzer des Portals sowie die Kontaktdaten
          der Ansprechpersonen zu den überwachten Objekten.
        </p>
      </>
    ),
  },
  {
    id: 'bereitstellung',
    title: 'Bereitstellung der Anwendung und Server-Logs',
    body: (
      <>
        <p>
          Bei jedem Aufruf des Portals verarbeitet unser Server technisch
          notwendige Daten, die Ihr Browser automatisch übermittelt:
        </p>
        <ul>
          <li>IP-Adresse des anfragenden Geräts</li>
          <li>Datum und Uhrzeit der Anfrage</li>
          <li>
            aufgerufene Adresse (URL), HTTP-Statuscode und übertragene
            Datenmenge
          </li>
          <li>
            zuvor besuchte Seite (Referrer), Browsertyp und Betriebssystem
          </li>
        </ul>
        <Facts
          purpose="Auslieferung der Anwendung, Gewährleistung von Stabilität und Sicherheit, Erkennung und Abwehr von Angriffen sowie Fehleranalyse."
          legalBasis="Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse liegt im sicheren und störungsfreien Betrieb der Anwendung."
          retention="Server-Logs werden in unserem Protokollsystem nach 30 Tagen automatisch gelöscht. Daten, deren Aufbewahrung zur Aufklärung eines konkreten Sicherheitsvorfalls erforderlich ist, werden bis zu dessen Abschluss aufbewahrt."
        />
        <h3>Fehleranalyse und Betriebsüberwachung</h3>
        <p>
          Tritt in der Anwendung ein Fehler auf, übermittelt der Server einen
          Fehlerbericht (Fehlermeldung, betroffene Funktion, technische
          Begleitinformationen) an ein Fehlerprotokoll, das wir selbst
          betreiben. Dabei werden standardmäßig keine personenbezogenen
          Merkmale wie IP-Adressen oder Anmeldedaten mitgesendet; im
          Einzelfall kann ein Bericht jedoch z. B. einen Benutzernamen
          enthalten. Für die Betriebsüberwachung erfassen wir zudem technische
          Kennzahlen (z. B. Antwortzeiten, Anzahl versendeter Nachrichten)
          ohne Personenbezug.
        </p>
        <Facts
          purpose="Erkennung und Behebung von Fehlern, Sicherstellung des Betriebs."
          legalBasis="Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse liegt im fehlerfreien Betrieb der Überwachung."
          retention="Fehlerberichte werden gelöscht, sobald sie für die Fehlerbehebung nicht mehr benötigt werden."
        />
        <h3>Verschlüsselung</h3>
        <p>
          Die Verbindung zum Portal wird per TLS verschlüsselt (erkennbar an
          „https://“ und dem Schloss-Symbol in der Adresszeile Ihres Browsers).
          Passwörter speichern wir ausschließlich als kryptografischen Hash, nie
          im Klartext.
        </p>
      </>
    ),
  },
  {
    id: 'konto',
    title: 'Benutzerkonto und Anmeldung',
    body: (
      <>
        <p>
          Die Nutzung des Portals setzt ein Benutzerkonto voraus. Konten werden
          von uns oder von einer Administratorin bzw. einem Administrator Ihres
          Unternehmens angelegt. Dabei verarbeiten wir:
        </p>
        <ul>
          <li>Benutzername, Vor- und Nachname, E-Mail-Adresse</li>
          <li>
            optional: Mobilfunknummer für SMS-Benachrichtigungen sowie der
            gewählte Messenger und Ihre Adresse dort (Signal- bzw.
            WhatsApp-Nummer oder Matrix-ID)
          </li>
          <li>Passwort (ausschließlich als Hash gespeichert)</li>
          <li>
            bei aktivierter Zwei-Faktor-Anmeldung: der geheime Schlüssel Ihrer
            Authenticator-App (verschlüsselt) und Ihre Wiederherstellungscodes
            (nur als Hash)
          </li>
          <li>
            Zugehörigkeit zu Ihrem Unternehmen, Rollen und Berechtigungen sowie
            die Ihnen zugeordneten Objekte und Benachrichtigungseinstellungen
          </li>
          <li>Zeitpunkt der Kontoerstellung und der letzten Anmeldung</li>
          <li>
            Spracheinstellung – sie bestimmt auch die Sprache Ihrer E-Mails und
            Messenger-Nachrichten
          </li>
        </ul>
        <Facts
          purpose="Bereitstellung des Portals, Anmeldung, Rechteverwaltung und Zustellung der von Ihnen gewünschten Benachrichtigungen."
          legalBasis={
            <>
              Art. 6 Abs. 1 lit. b DSGVO, soweit Sie selbst unser
              Vertragspartner sind. Nutzen Sie das Portal als Beschäftigte bzw.
              Beschäftigter eines Kunden, ist Rechtsgrundlage Art. 6 Abs. 1 lit.
              f DSGVO – unser und das berechtigte Interesse Ihres Arbeitgebers
              liegt in der vertragsgemäßen Bereitstellung des Portals für dessen
              Mitarbeitende.
            </>
          }
          retention="Für die Dauer des Bestehens Ihres Benutzerkontos. Nach Löschung des Kontos werden die Daten gelöscht, soweit keine gesetzlichen Aufbewahrungspflichten entgegenstehen. In Datensicherungen verbleiben sie bis zu deren turnusmäßiger Überschreibung."
        />
        <h3>Anmeldelinks, Passwort-Zurücksetzen und Schutz vor Missbrauch</h3>
        <p>
          Auf Wunsch senden wir Ihnen einen einmaligen Anmeldelink per E-Mail;
          auch Einladungen und das Zurücksetzen des Passworts (nur mit
          Zwei-Faktor-Anmeldung) laufen über solche Links. Nutzerinnen und
          Nutzer unserer bisherigen Plattform erhalten zum Umzug einmalig eine
          Info-E-Mail mit einem Link, über den sie ihr Passwort festlegen und
          sich anmelden; wir vermerken, wann sie versendet und genutzt wurde.
          Wir speichern davon
          nur einen Hash, die Gültigkeitsdauer und den Zeitpunkt der
          Verwendung, nicht den Link selbst; im Versandprotokoll erscheint er
          unkenntlich gemacht. Fehlgeschlagene Anmeldeversuche zählen wir je
          Benutzername und je IP-Adresse für 15 Minuten, um das Erraten von
          Passwörtern zu verhindern.
        </p>
        <Facts
          purpose="Sichere Anmeldung ohne Passwort, Schutz Ihres Kontos, zusammengefasste Auswertung, wie häufig Anmeldelinks genutzt werden."
          legalBasis="Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO (wie beim Benutzerkonto)."
          retention="Fehlversuche: 15 Minuten. Unbenutzte Links verfallen nach ihrer Gültigkeit (Minuten bis wenige Tage) und werden durch neue ersetzt; die Angabe, wann ein Link verwendet wurde, bleibt für die Dauer des Benutzerkontos gespeichert."
        />
        <h3>Zugangsanfrage</h3>
        <p>
          Über das Formular „Zugang beantragen“ können Sie ein Benutzerkonto
          anfragen. Wir verarbeiten dabei Vor- und Nachname, Unternehmen,
          E-Mail-Adresse, Telefonnummer (optional), Projekt und Ihre Nachricht,
          die gewählte Sprache (für unsere E-Mails an Sie) sowie den Zeitpunkt,
          zu dem Sie diese Datenschutzerklärung zur Kenntnis genommen haben. Ihre E-Mail-Adresse bestätigen Sie über
          einen Link (Double-Opt-in); danach prüfen unsere Mitarbeitenden die
          Anfrage.
        </p>
        <Facts
          purpose="Prüfung der Anfrage und Einrichtung eines Benutzerkontos."
          legalBasis="Art. 6 Abs. 1 lit. b DSGVO (vorvertragliche Maßnahme auf Ihre Anfrage)."
          retention="Nicht bestätigte Anfragen werden nach 7 Tagen gelöscht, abgelehnte Anfragen nach 90 Tagen. Nach einer Freigabe gelten die Fristen des Benutzerkontos."
        />
        <h3>Support-Zugriff</h3>
        <p>
          Zur Unterstützung bei Fragen und Störungen können ausgewählte
          ProGeo-Administratorinnen und -Administratoren das Portal aus Sicht
          Ihres Benutzerkontos ansehen („Anmelden als“). Jeder solche Zugriff
          wird mit Zeitpunkt und handelnder Person protokolliert. Ihr Passwort
          erfahren wir dabei nicht, und der Zeitpunkt Ihrer letzten Anmeldung
          bleibt unverändert.
        </p>
        <h3>Protokollierung von Aktionen</h3>
        <p>
          Zur Nachvollziehbarkeit und zum Schutz vor Missbrauch protokollieren
          wir Anmeldungen und sicherheits- bzw. betriebsrelevante Aktionen im
          Portal (z. B. Bearbeitung von Alarmen, Steuerung von Geräten,
          Datensicherungen, Datei-Uploads). Gespeichert werden das
          Benutzerkonto, das Unternehmen, der Zeitpunkt, die aufgerufene
          Funktion sowie die übermittelten Eingaben bzw. Dateinamen. Passwörter
          werden dabei nicht protokolliert.
        </p>
        <Facts
          purpose="Nachvollziehbarkeit von Änderungen an Alarmen und Geräten, Fehleranalyse, Missbrauchserkennung."
          legalBasis="Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse liegt in der Sicherheit und Nachvollziehbarkeit des Überwachungsbetriebs."
          retention="Solange es für die genannten Zwecke erforderlich ist, längstens bis zum Ende des Vertragsverhältnisses mit Ihrem Unternehmen."
        />
      </>
    ),
  },
  {
    id: 'objektdaten',
    title: 'Objekt- und Kontaktdaten',
    body: (
      <>
        <p>
          Zu jedem überwachten Objekt speichern wir die Objektadresse und
          Koordinaten sowie die Kontaktdaten von Ansprechpersonen (Name,
          Telefonnummer, E-Mail-Adresse) – sowohl auf Kundenseite als auch die
          zuständigen Mitarbeitenden von ProGeo.
        </p>
        <p>
          Diese Daten erhalten wir in der Regel nicht von den Ansprechpersonen
          selbst, sondern von unserem Kunden bei Beauftragung bzw. bei der
          Einrichtung des Objekts (Art. 14 DSGVO).
        </p>
        <Facts
          purpose="Durchführung des Überwachungsauftrags, Kontaktaufnahme im Alarm- oder Störungsfall, Koordination von Service-Einsätzen."
          legalBasis="Art. 6 Abs. 1 lit. b DSGVO gegenüber unseren Vertragspartnern; im Übrigen Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in der schnellen Erreichbarkeit der zuständigen Personen bei Schäden am Objekt."
          retention="Für die Dauer des Überwachungsauftrags; danach Löschung, soweit keine gesetzlichen Aufbewahrungspflichten bestehen."
          recipients="Nutzerinnen und Nutzer, die für das jeweilige Objekt freigeschaltet sind."
        />
      </>
    ),
  },
  {
    id: 'benachrichtigungen',
    title: 'Benachrichtigungen per E-Mail, SMS und Messenger',
    body: (
      <>
        <p>
          Je nach Ihren Einstellungen informiert Sie das Portal per E-Mail,
          SMS und/oder Messenger (ProGeo Chat, Signal oder WhatsApp) über
          Alarme, Verbindungsabbrüche von Messsystemen, Berichte und
          Testmeldungen. Dazu verarbeiten wir Ihre E-Mail-Adresse,
          Mobilfunknummer bzw. Messenger-Adresse, Ihre Spracheinstellung sowie
          den Inhalt der Nachricht (z. B. Objektname, Projektnummer und Art
          des Ereignisses). Jede versendete Nachricht wird mit Empfänger,
          Inhalt und Zustellstatus protokolliert; Links zum Anmelden oder
          Quittieren erscheinen im Protokoll unkenntlich gemacht.
        </p>
        <h3>Stufenweise Benachrichtigung, Quittieren und Abbestellen</h3>
        <p>
          Bleibt ein Alarm unquittiert oder eine Störung bestehen, erinnern wir
          die eingetragenen Empfängerinnen und Empfänger in festen Abständen
          und beziehen in späteren Stufen die zuständige ProGeo-Objektleitung
          ein; zuletzt wird der Vorgang intern eskaliert. Störungsmeldungen
          versenden wir nur zwischen 9 und 22 Uhr, Alarme jederzeit. Zu jedem
          Vorgang protokollieren wir, wer wann benachrichtigt wurde, welche
          Nachrichten unzustellbar waren und wer den Empfang bestätigt, einen
          Alarm quittiert oder Benachrichtigungen abbestellt hat.
        </p>
        <p>
          Jede Benachrichtigungs-E-Mail enthält einen persönlichen Link zum
          Quittieren bzw. Bestätigen und einen Link zum Abbestellen; Ihr
          E-Mail-Programm kann die Abmeldung auch direkt auslösen
          („List-Unsubscribe“). Von diesen Links speichern wir nur einen Hash;
          sie sind 60 Tage gültig. Beim Abbestellen bleibt Ihr Portalzugang
          bestehen; wir vermerken die Abmeldung (Adresse, Objekt, Art der
          Benachrichtigung, Zeitpunkt) als Nachweis.
        </p>
        <h3>E-Mail und Unzustellbarkeitsmeldungen</h3>
        <p>
          E-Mails versenden wir über unseren eigenen Mailserver. Meldet ein
          empfangender Mailserver eine E-Mail als unzustellbar, werten wir diese
          automatische Rückmeldung aus und sperren eine dauerhaft unzustellbare
          Adresse für weitere Nachrichten, bis sie berichtigt wird.
        </p>
        <h3>SMS-Versand über Esendex</h3>
        <p>
          Für den Versand von SMS setzen wir den Dienstleister Esendex (Esendex
          Limited, Vereinigtes Königreich) als Auftragsverarbeiter ein. Esendex
          erhält dafür die Mobilfunknummer und den Nachrichtentext. Die
          Übermittlung in das Vereinigte Königreich erfolgt auf Grundlage des
          Angemessenheitsbeschlusses der EU-Kommission (Art. 45 DSGVO).
        </p>
        <h3>WhatsApp</h3>
        <p>
          Wählen Sie WhatsApp, senden wir die Nachrichten über die WhatsApp
          Business Platform (Cloud API) der Meta Platforms Ireland Ltd.,
          Merrion Road, Dublin 4, Irland. Meta erhält dafür Ihre Telefonnummer
          und den Nachrichtentext; eine Verarbeitung durch die Meta Platforms,
          Inc. in den USA ist möglich. Die Übermittlung in die USA erfolgt auf
          Grundlage des EU-U.S. Data Privacy Framework (Art. 45 DSGVO) bzw. der
          Standardvertragsklauseln der EU-Kommission (Art. 46 DSGVO) (
          <ExternalLink href="https://www.whatsapp.com/legal/business-data-processing-terms">
            Bedingungen
          </ExternalLink>
          ).
        </p>
        <h3>Signal</h3>
        <p>
          Wählen Sie Signal, senden wir die Nachrichten von der Signal-Nummer
          von ProGeo über unseren eigenen Chat-Server an Ihre Signal-Nummer.
          Die Zustellung übernimmt der Dienst Signal (Signal Messenger LLC,
          USA). Die Nachrichten sind auf dem Weg zu Ihnen Ende-zu-Ende
          verschlüsselt; Signal erhält jedoch Ihre Telefonnummer als
          Empfängeradresse (
          <ExternalLink href="https://signal.org/legal/">Datenschutzhinweise von Signal</ExternalLink>
          ).
        </p>
        <Facts
          purpose="Zustellung von Alarm- und Statusmeldungen, Erinnerung bis zur Behebung bzw. Quittierung; Nachweis der erfolgten bzw. fehlgeschlagenen Zustellung, der Quittierung und von Abmeldungen."
          legalBasis="Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO (wie beim Benutzerkonto). Die Benachrichtigungen sind wesentlicher Bestandteil der Überwachungsleistung. Die Wahl von SMS und Messenger ist freiwillig."
          retention="Versandprotokolle, Benachrichtigungsvorgänge und Abmeldungen werden für die Dauer des Überwachungsauftrags aufbewahrt, um die Zustellung von Alarmmeldungen nachweisen zu können. Gesperrte Adressen bleiben gesperrt, bis sie berichtigt werden."
          recipients="Esendex (SMS) als Auftragsverarbeiter gemäß Art. 28 DSGVO; je nach Ihrer Wahl Meta (WhatsApp) bzw. Signal."
        />
      </>
    ),
  },
  {
    id: 'chat',
    title: 'ProGeo Chat (Matrix)',
    body: (
      <>
        <p>
          Der ProGeo Chat ist ein Chat-Server nach dem offenen Standard
          Matrix, den wir selbst betreiben. Die Nutzung ist freiwillig. Sie
          melden sich in einer Chat-App mit Ihrem ProGeo-Zugang an – über die
          Anmeldeseite des Portals oder über einen QR-Code in Ihrem Profil, der
          eine einmalige, 10 Minuten gültige Anmeldung ermöglicht (wir
          speichern davon nur einen Hash und den Zeitpunkt der Verwendung).
          Bei der ersten Anmeldung entsteht Ihr Chat-Konto.
        </p>
        <p>Auf unserem Chat-Server werden dabei verarbeitet:</p>
        <ul>
          <li>Ihre Matrix-ID (abgeleitet aus Ihrem Benutzernamen) und Ihr Anzeigename</li>
          <li>
            Ihre angemeldeten Geräte und Sitzungen sowie deren IP-Adressen und
            App-Bezeichnungen
          </li>
          <li>
            Ihre Chats und Nachrichten, auch die Benachrichtigungen unseres
            Systems; den Zeitpunkt Ihrer letzten Anmeldung in einer Chat-App
            zeigt das Portal in Ihrem Profil an
          </li>
        </ul>
        <p>
          Nachrichten unseres Benachrichtigungssystems sind nicht
          Ende-zu-Ende-verschlüsselt: Sie werden verschlüsselt übertragen,
          liegen auf unserem Server aber lesbar vor. Chats zwischen
          Nutzerinnen und Nutzern verschlüsselt die App Ende-zu-Ende.
        </p>
        <p>
          Die Chat-App installieren Sie selbst aus dem App Store bzw. von
          Google Play; wir empfehlen Element X (Element Creations Ltd.,
          Vereinigtes Königreich). Beim Öffnen unseres Einrichtungslinks bzw.
          QR-Codes ruft Ihr Gerät eine Seite von Element (mobile.element.io)
          auf, die die App mit unserem Server öffnet. Damit Sie Nachrichten
          auch bei geschlossener App erhalten, leitet unser Server
          Push-Benachrichtigungen über den Push-Dienst des App-Anbieters an
          Apple bzw. Google weiter; dabei werden technische Kennungen (z. B.
          Nachrichten- und Chat-Kennung) übermittelt. Für die App und diese
          Dienste gelten die Datenschutzhinweise des jeweiligen Anbieters (
          <ExternalLink href="https://element.io/privacy">Element</ExternalLink>
          ).
        </p>
        <Facts
          purpose="Bereitstellung des Chats und Zustellung von Benachrichtigungen per Messenger."
          legalBasis="Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO (wie beim Benutzerkonto)."
          retention="Für die Dauer Ihres Benutzerkontos. Wird Ihr Portalzugang deaktiviert, wird auch das Chat-Konto deaktiviert; wird er gelöscht, löschen wir das Chat-Konto samt Inhalten. Die IP-Adressen Ihrer Geräte speichert der Chat-Server höchstens 28 Tage. Die Matrix-ID selbst wird aus technischen Gründen nicht erneut vergeben."
          recipients="Keine Weitergabe der Inhalte; technische Push-Kennungen an den Push-Dienst Ihrer App bzw. an Apple oder Google."
        />
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies und lokale Speicherung',
    body: (
      <>
        <p>
          Das Portal verwendet ausschließlich technisch notwendige Cookies und
          Browser-Speicher. Wir setzen keine Analyse-, Tracking- oder
          Werbe-Cookies ein.
        </p>
        <div className="privacy-table-wrap">
          <table className="privacy-table" data-testid="privacy-policy-cookie-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Art</th>
                <th>Zweck</th>
                <th>Dauer</th>
              </tr>
            </thead>
            <tbody>
              {BROWSER_STORAGE.map((item) => (
                <tr key={item.name}>
                  <td>{item.code ? <code>{item.name}</code> : item.name}</td>
                  <td>{item.kind}</td>
                  <td>{item.purpose}</td>
                  <td>{item.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Facts
          purpose="Bereitstellung der von Ihnen ausdrücklich gewünschten Anwendung und Schutz Ihres Kontos."
          legalBasis="§ 25 Abs. 2 Nr. 2 TDDDG (Speicherung ist unbedingt erforderlich) in Verbindung mit Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO."
          retention="Siehe Tabelle."
        />
      </>
    ),
  },
  {
    id: 'kartendienste',
    title: 'Externe Kartendienste (nur mit Einwilligung)',
    body: (
      <>
        <p>
          Zur Darstellung von Objektstandorten kann das Portal Kartenkacheln
          externer Anbieter laden. Dies geschieht{' '}
          <strong>nur, wenn Sie zuvor eingewilligt haben</strong>; ohne
          Einwilligung werden die Standorte ohne Kartenhintergrund angezeigt.
        </p>
        <ul>
          <li>
            <strong>OpenStreetMap</strong> – OpenStreetMap Foundation, St John’s
            Innovation Centre, Cowley Road, Cambridge, CB4 0WS, Vereinigtes
            Königreich (
            <ExternalLink href="https://osmfoundation.org/wiki/Privacy_Policy">
              Datenschutzerklärung
            </ExternalLink>
            )
          </li>
          <li>
            <strong>Esri ArcGIS Online</strong> (Satellitenbilder und Ortsbeschriftungen) –
            Environmental Systems Research Institute, Inc., 380 New York Street,
            Redlands, CA 92373, USA (
            <ExternalLink href="https://www.esri.com/en-us/privacy/overview">
              Datenschutzerklärung
            </ExternalLink>
            )
          </li>
        </ul>
        <p>
          Beim Laden der Karten übermittelt Ihr Browser Ihre IP-Adresse, den
          angefragten Kartenausschnitt sowie Browserinformationen direkt an den
          jeweiligen Anbieter. Dabei können Daten in Drittländer übermittelt
          werden, insbesondere in die USA. Soweit für das Empfängerland kein
          Angemessenheitsbeschluss der EU-Kommission besteht bzw. der Anbieter
          nicht nach dem EU-U.S. Data Privacy Framework zertifiziert ist,
          erfolgt die Übermittlung auf Grundlage Ihrer ausdrücklichen
          Einwilligung (Art. 49 Abs. 1 lit. a DSGVO). In diesem Fall besteht das
          Risiko, dass Behörden des Drittlands auf die Daten zugreifen, ohne
          dass Ihnen gleichwertige Rechtsbehelfe zur Verfügung stehen.
        </p>
        <Facts
          purpose="Darstellung von Objektstandorten auf einer Karte."
          legalBasis="Ihre Einwilligung gemäß § 25 Abs. 1 TDDDG und Art. 6 Abs. 1 lit. a DSGVO."
          retention="Wir selbst speichern dabei keine Daten. Für die Verarbeitung durch die Anbieter gelten deren Datenschutzerklärungen."
          recipients="OpenStreetMap Foundation, Esri Inc. (jeweils eigenverantwortlich)."
        />
        <div className="privacy-callout">
          <strong>Einwilligung jederzeit widerrufen</strong>
          <p>
            Ihre Auswahl können Sie jederzeit mit Wirkung für die Zukunft ändern
            – über das Info-Menü (i) in der Kopfleiste oder direkt hier:
          </p>
          {consentButton}
        </div>
      </>
    ),
  },
  {
    id: 'nutzungsstatistik',
    title: 'Nutzungsstatistik (nur mit Einwilligung)',
    body: (
      <>
        <p>
          <strong>
            Nur wenn Sie in die „Nutzungsstatistik“ eingewilligt haben
          </strong>
          , erfassen wir, wie Sie das Portal nutzen, um es zu verbessern (z. B.
          welche Funktionen gebraucht werden und wo Bedienschritte zu lange
          dauern). Ohne Einwilligung sendet Ihr Browser dafür nichts.
        </p>
        <p>
          Bei angemeldeten Nutzerinnen und Nutzern speichern wir auf unserem
          Server, <strong>bezogen auf Ihr Benutzerkonto</strong>:
        </p>
        <ul>
          <li>
            die aufgerufenen Seiten (ohne Kennungen, z. B. „Objekt – Analyse“
            statt der Nummer des Objekts) und wie lange die Seite sichtbar war,
          </li>
          <li>
            angeklickte Schaltflächen und Bedienelemente – nur deren
            technische Bezeichnung, nie Texte oder Eingaben,
          </li>
          <li>Zeitpunkte Ihrer Anmeldungen,</li>
          <li>
            eine zufällige Kennung je Browser-Tab, um zusammengehörige Aufrufe
            zu erkennen.
          </li>
        </ul>
        <p>
          Wir speichern dabei weder Ihre IP-Adresse noch Angaben zu Ihrem
          Browser oder Gerät, setzen keine Cookies und geben nichts an Dritte
          weiter. Konten unserer Mitarbeiterinnen und Mitarbeiter werden nicht
          erfasst. Die Daten werten wir zusammengefasst aus (z. B. Aufrufe und
          Verweildauer je Seite); sie dienen nicht der Leistungs- oder
          Verhaltenskontrolle einzelner Personen.
        </p>
        <p>
          <strong>Öffentliche Demo:</strong> Für jeden Besuch über einen
          Demo-Link erfassen wir zudem den verwendeten Demo-Link, den Beginn und
          den Zeitpunkt der letzten Aktivität, die Anzahl der Anfragen an den
          Server und die Spracheinstellung des Browsers. Diese Angaben fallen
          bei der Bereitstellung der Demo ohnehin an. Mit Ihrer Einwilligung
          sendet Ihr Browser in der Demo außerdem etwa alle 30 Sekunden eine
          kurze Aktivitätsmeldung, solange der Tab sichtbar ist und Sie die Demo
          bedienen; daraus ermitteln wir die aktive Nutzungsdauer und die
          aufgerufenen Bereiche. Diese Daten werden je Demo-Link ausgewertet.
        </p>
        <Facts
          purpose="Auswertung, wie und wie lange das Portal und die Demo genutzt werden, um sie zu verbessern."
          legalBasis="Ihre Einwilligung gemäß § 25 Abs. 1 TDDDG und Art. 6 Abs. 1 lit. a DSGVO. Erfassung der Demo-Besuche: unser berechtigtes Interesse an der Auswertung der Demo (Art. 6 Abs. 1 lit. f DSGVO)."
          retention="Seitenaufrufe, Klicks und Anmeldungen werden nach 180 Tagen automatisch gelöscht. Demo-Besuche: solange der jeweilige Demo-Link ausgewertet wird."
        />
        <div className="privacy-callout">
          <strong>Einwilligung jederzeit widerrufen</strong>
          <p>
            Ihre Einwilligung können Sie jederzeit mit Wirkung für die Zukunft
            in den Datenschutz-Einstellungen widerrufen – über das Info-Menü
            (i) in der Kopfleiste oder oben auf dieser Seite. Ab dann sendet
            Ihr Browser keine Nutzungsdaten mehr.
          </p>
        </div>
      </>
    ),
  },
  {
    id: 'empfaenger',
    title: 'Empfänger und Auftragsverarbeiter',
    body: (
      <>
        <p>
          Wir geben personenbezogene Daten nur weiter, soweit dies für die oben
          genannten Zwecke erforderlich ist. Dienstleister, die in unserem
          Auftrag Daten verarbeiten (z. B. für Hosting, Wartung der Server und
          SMS-Versand), haben wir sorgfältig ausgewählt und nach Art. 28 DSGVO
          vertraglich verpflichtet; sie dürfen die Daten nur nach unserer
          Weisung verwenden.
        </p>
        <p>
          Innerhalb Ihres Unternehmens sehen diejenigen Nutzerinnen und Nutzer
          Ihre Daten, die für dieselben Objekte freigeschaltet sind bzw.
          Administrationsrechte haben.
        </p>
        <p>
          Für Wetterdaten (Niederschlag, zur Einordnung von Alarmen) übermittelt
          unser Server die Koordinaten der betreffenden Objekte an Open-Meteo
          (open-meteo.com); dabei werden keine Daten von Nutzerinnen und
          Nutzern übertragen.
        </p>
        <p>
          Wir verkaufen keine Daten, nutzen sie nicht für Werbung und erstellen
          keine Nutzerprofile für Werbezwecke.
        </p>
      </>
    ),
  },
  {
    id: 'speicherdauer',
    title: 'Speicherdauer und Datensicherung',
    body: (
      <>
        <p>
          Wir speichern personenbezogene Daten nur so lange, wie es für den
          jeweiligen Zweck erforderlich ist oder gesetzliche
          Aufbewahrungspflichten (insbesondere nach Handels- und Steuerrecht,
          bis zu zehn Jahre) bestehen. Die konkreten Fristen finden Sie in den
          jeweiligen Abschnitten.
        </p>
        <p>
          Zum Schutz vor Datenverlust erstellen wir täglich Datensicherungen
          und übertragen sie verschlüsselt auf einen getrennten
          Sicherungsserver; dort werden sie nach 14 Tagen durch neuere
          ersetzt. Gelöschte Daten können darin noch bis zu deren turnusmäßiger
          Überschreibung enthalten sein; sie werden in dieser Zeit nicht für
          andere Zwecke verwendet.
        </p>
        <p>
          Bevor wir Änderungen an der Anwendung in Betrieb nehmen, prüfen wir
          sie auf einem eigenen Testsystem mit einer verschlüsselt
          übertragenen Kopie der Daten; dort werden nur die beiden jüngsten
          Kopien vorgehalten. Das Testsystem ist wie das Portal geschützt und
          versendet keine Nachrichten an Kundinnen und Kunden (Art. 6 Abs. 1
          lit. f DSGVO – unser berechtigtes Interesse an einem fehlerfreien
          Betrieb der Überwachung).
        </p>
      </>
    ),
  },
  {
    id: 'rechte',
    title: 'Ihre Rechte',
    body: (
      <>
        <p>Sie haben uns gegenüber folgende Rechte hinsichtlich Ihrer Daten:</p>
        <ul>
          <li>Recht auf Auskunft (Art. 15 DSGVO)</li>
          <li>Recht auf Berichtigung (Art. 16 DSGVO)</li>
          <li>Recht auf Löschung (Art. 17 DSGVO)</li>
          <li>Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
          <li>Recht auf Datenübertragbarkeit (Art. 20 DSGVO)</li>
          <li>
            Recht auf Widerruf erteilter Einwilligungen mit Wirkung für die
            Zukunft (Art. 7 Abs. 3 DSGVO); die Rechtmäßigkeit der bis zum
            Widerruf erfolgten Verarbeitung bleibt unberührt
          </li>
        </ul>
        <p>
          Wenden Sie sich dazu formlos an{' '}
          <a href={`mailto:${CONTROLLER.email}`} {...repeatedTestId('privacy-policy-mail-link', 'rechte')}>{CONTROLLER.email}</a>. Ihren
          Namen, Ihre E-Mail-Adresse, Ihre Mobilfunknummer, Ihren Messenger
          und Ihre Sprache können Sie außerdem jederzeit selbst in Ihrem
          Profil im Portal ändern; Benachrichtigungen können Sie über den Link
          in jeder Benachrichtigungs-E-Mail abbestellen.
        </p>
        <div className="privacy-callout">
          <strong>Widerspruchsrecht nach Art. 21 DSGVO</strong>
          <p>
            Soweit wir Ihre Daten auf Grundlage berechtigter Interessen (Art. 6
            Abs. 1 lit. f DSGVO) verarbeiten, haben Sie das Recht, aus Gründen,
            die sich aus Ihrer besonderen Situation ergeben, jederzeit
            Widerspruch gegen diese Verarbeitung einzulegen. Wir verarbeiten die
            Daten dann nicht mehr, es sei denn, wir können zwingende
            schutzwürdige Gründe nachweisen, die Ihre Interessen, Rechte und
            Freiheiten überwiegen, oder die Verarbeitung dient der
            Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen.
          </p>
        </div>
      </>
    ),
  },
  {
    id: 'beschwerde',
    title: 'Beschwerderecht bei der Aufsichtsbehörde',
    body: (
      <>
        <p>
          Sie haben das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu
          beschweren (Art. 77 DSGVO), insbesondere in dem Mitgliedstaat Ihres
          Aufenthaltsorts, Ihres Arbeitsplatzes oder des Orts des mutmaßlichen
          Verstoßes. Die für uns zuständige Aufsichtsbehörde ist:
        </p>
        <address className="privacy-address">
          <strong>
            Die Landesbeauftragte für den Datenschutz und für das Recht auf
            Akteneinsicht Brandenburg
          </strong>
          <span>Stahnsdorfer Damm 77</span>
          <span>14532 Kleinmachnow</span>
          <span>
            <ExternalLink href="https://www.lda.brandenburg.de">
              www.lda.brandenburg.de
            </ExternalLink>
          </span>
        </address>
      </>
    ),
  },
  {
    id: 'sonstiges',
    title: 'Pflicht zur Bereitstellung, automatisierte Entscheidungen',
    body: (
      <>
        <p>
          Die Angabe von Name und E-Mail-Adresse ist für die Nutzung des Portals
          erforderlich; ohne diese Daten kann kein Benutzerkonto eingerichtet
          werden. Die Angabe einer Mobilfunknummer bzw. Messenger-Adresse und
          die Nutzung des ProGeo Chats sind freiwillig und nur für
          Benachrichtigungen auf diesen Wegen nötig.
        </p>
        <p>
          Eine automatisierte Entscheidungsfindung einschließlich Profiling im
          Sinne von Art. 22 DSGVO findet nicht statt. Alarme werden zwar
          automatisch ausgelöst, sie beruhen jedoch ausschließlich auf
          Messwerten der überwachten Bauwerke.
        </p>
      </>
    ),
  },
  {
    id: 'aenderungen',
    title: 'Änderungen dieser Datenschutzerklärung',
    body: (
      <p>
        Wir passen diese Datenschutzerklärung an, sobald sich die Anwendung oder
        die rechtlichen Anforderungen ändern. Es gilt die jeweils hier
        veröffentlichte Fassung. Stand: {PRIVACY_POLICY_LAST_UPDATED}.
      </p>
    ),
  },
];
