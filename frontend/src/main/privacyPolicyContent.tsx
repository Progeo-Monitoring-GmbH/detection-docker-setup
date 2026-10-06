import type { ReactNode } from 'react';

/*
 * Wording of the privacy policy (German, legally binding version).
 *
 * Keep this in sync with what the application actually does - every new
 * third-party service, cookie/storage key or log must be added here, and
 * material changes need a new PRIVACY_POLICY_LAST_UPDATED (and, if the consent
 * categories change, a CONSENT_VERSION bump in components/privacy/consent.ts).
 */

export const PRIVACY_POLICY_LAST_UPDATED = 'Oktober 2026';

export const CONTROLLER = {
  name: 'ProGeo Monitoring Systeme und Services GmbH & Co. KG',
  street: 'Hauptstraße 2',
  city: '14979 Großbeeren',
  country: 'Deutschland',
  phone: '+49 33701 22-0',
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
    purpose: 'Anmeldesitzung',
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
};

/** Purpose / legal basis / retention block, as required per processing by Art. 13 GDPR. */
const Facts = ({ purpose, legalBasis, retention, recipients }: FactsProps) => (
  <dl className="privacy-facts">
    <dt>Zweck</dt>
    <dd>{purpose}</dd>
    <dt>Rechtsgrundlage</dt>
    <dd>{legalBasis}</dd>
    <dt>Speicherdauer</dt>
    <dd>{retention}</dd>
    {recipients && (
      <>
        <dt>Empfänger</dt>
        <dd>{recipients}</dd>
      </>
    )}
  </dl>
);

const ExternalLink = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

type SectionOptions = {
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
            <a href={`mailto:${CONTROLLER.email}`}>{CONTROLLER.email}</a>
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
          Benachrichtigungen per E-Mail und SMS. Das Portal dient unseren
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
          retention="Server-Logs werden nur so lange gespeichert, wie es für die genannten Zwecke erforderlich ist, und anschließend automatisch gelöscht. Daten, deren Aufbewahrung zur Aufklärung eines konkreten Sicherheitsvorfalls erforderlich ist, werden bis zu dessen Abschluss aufbewahrt."
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
          <li>optional: Mobilfunknummer für SMS-Benachrichtigungen</li>
          <li>Passwort (ausschließlich als Hash gespeichert)</li>
          <li>
            Zugehörigkeit zu Ihrem Unternehmen, Rollen und Berechtigungen sowie
            die Ihnen zugeordneten Objekte und Benachrichtigungseinstellungen
          </li>
          <li>Zeitpunkt der Kontoerstellung und der letzten Anmeldung</li>
          <li>Spracheinstellung</li>
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
    title: 'Benachrichtigungen per E-Mail und SMS',
    body: (
      <>
        <p>
          Je nach Ihren Einstellungen informiert Sie das Portal per E-Mail
          und/oder SMS über Alarme, Verbindungsabbrüche von Messsystemen,
          Berichte und Testmeldungen. Dazu verarbeiten wir Ihre E-Mail-Adresse
          bzw. Mobilfunknummer sowie den Inhalt der Nachricht (z. B. Objektname,
          Projektnummer und Art des Ereignisses). Jede versendete Nachricht wird
          mit Empfänger, Inhalt und Zustellstatus protokolliert.
        </p>
        <h3>E-Mail</h3>
        <p>E-Mails versenden wir über unseren eigenen Mailserver.</p>
        <h3>SMS-Versand über Esendex</h3>
        <p>
          Für den Versand von SMS setzen wir den Dienstleister Esendex (Esendex
          Limited, Vereinigtes Königreich) als Auftragsverarbeiter ein. Esendex
          erhält dafür die Mobilfunknummer und den Nachrichtentext. Die
          Übermittlung in das Vereinigte Königreich erfolgt auf Grundlage des
          Angemessenheitsbeschlusses der EU-Kommission (Art. 45 DSGVO).
        </p>
        <Facts
          purpose="Zustellung von Alarm- und Statusmeldungen; Nachweis der erfolgten bzw. fehlgeschlagenen Zustellung."
          legalBasis="Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO (wie beim Benutzerkonto). Die Benachrichtigungen sind wesentlicher Bestandteil der Überwachungsleistung."
          retention="Versandprotokolle werden für die Dauer des Überwachungsauftrags aufbewahrt, um die Zustellung von Alarmmeldungen nachweisen zu können."
          recipients="Esendex (SMS) als Auftragsverarbeiter gemäß Art. 28 DSGVO."
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
          <table className="privacy-table">
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
            <strong>Esri ArcGIS Online</strong> (Satellitenbilder) –
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
          Wir verkaufen keine Daten, nutzen sie nicht für Werbung und erstellen
          keine Nutzerprofile.
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
          Zum Schutz vor Datenverlust erstellen wir regelmäßig Datensicherungen.
          Gelöschte Daten können darin noch bis zu deren turnusmäßiger
          Überschreibung enthalten sein; sie werden in dieser Zeit nicht für
          andere Zwecke verwendet.
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
          <a href={`mailto:${CONTROLLER.email}`}>{CONTROLLER.email}</a>. Ihren
          Namen, Ihre E-Mail-Adresse und Ihre Mobilfunknummer können Sie
          außerdem jederzeit selbst in Ihrem Profil im Portal ändern.
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
          werden. Die Angabe einer Mobilfunknummer ist freiwillig und nur für
          SMS-Benachrichtigungen nötig.
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
