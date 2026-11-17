import { repeatedTestId } from '../testIds';
import {
  CONTROLLER,
  ExternalLink,
  Facts as FactsDe,
  PRIVACY_POLICY_LAST_UPDATED,
  type FactLabels,
  type PolicySection,
  type SectionOptions,
} from './privacyPolicyContent';

/*
 * English translation of the privacy policy (privacyPolicyContent.tsx is
 * the German, legally binding version). Same sections, same ids - change
 * both together.
 */

const LABELS: FactLabels = {
  purpose: 'Purpose',
  legalBasis: 'Legal basis',
  retention: 'Retention period',
  recipients: 'Recipients',
};

const Facts = (props: Omit<Parameters<typeof FactsDe>[0], 'labels'>) => <FactsDe {...props} labels={LABELS} />;

// Every cookie / browser storage key the app sets - the same as BROWSER_STORAGE of the German version.
const BROWSER_STORAGE = [
  { name: 'csrftoken', code: true, kind: 'Cookie', purpose: 'Protection against cross-site request forgery attacks', duration: 'up to 1 year' },
  { name: 'sessionid', code: true, kind: 'Cookie', purpose: 'Sign-in session (also for signing in to the ProGeo chat)', duration: 'until sign-out, max. 2 weeks' },
  { name: 'authToken', code: true, kind: 'Local Storage', purpose: 'Sign-in token for the communication with the server', duration: 'until sign-out' },
  { name: 'refreshToken', code: true, kind: 'Local Storage', purpose: 'Renews the sign-in token without signing in again', duration: 'until sign-out' },
  { name: 'progeo_consent', code: true, kind: 'Local Storage', purpose: 'Stores your privacy choices', duration: '12 months' },
  { name: 'i18nextLng', code: true, kind: 'Local Storage', purpose: 'Selected language', duration: 'until deleted in the browser' },
  { name: 'progeo.languageChosen', code: true, kind: 'Session Storage', purpose: 'Language selected on the sign-in page - stored in your profile after signing in', duration: 'until signing in or closing the tab' },
  { name: 'progeo.sidebar.collapsed, progeo.canvasKeyLegend.collapsed, progeo.map.baseLayer', code: true, kind: 'Local Storage', purpose: 'Display: collapsed sidebar or legend, selected map view', duration: 'until deleted in the browser' },
  { name: 'demoToken', code: true, kind: 'Local Storage', purpose: 'Public demo only: signing in again with the same demo link', duration: 'until the demo link expires' },
  { name: 'impersonatorTokens, viewAsUser', code: true, kind: 'Local Storage', purpose: 'ProGeo staff only: support view ("log in as", "show as user")', duration: 'until sign-out' },
  { name: 'Cache', code: false, kind: 'Session Storage', purpose: 'Speeds up loading data that was already retrieved', duration: 'until the tab is closed' },
];

export const buildPolicySectionsEn = ({ consentButton }: SectionOptions): PolicySection[] => [
  {
    id: 'verantwortlicher',
    title: 'Controller',
    body: (
      <>
        <p>
          The controller responsible for the processing of personal data in
          this application within the meaning of the General Data Protection
          Regulation (GDPR) is:
        </p>
        <address className="privacy-address">
          <strong>{CONTROLLER.name}</strong>
          <span>{CONTROLLER.street}</span>
          <span>
            {CONTROLLER.city}, Germany
          </span>
          <span>Phone: {CONTROLLER.phone}</span>
          <span>
            E-mail:{' '}
            <a href={`mailto:${CONTROLLER.email}`} {...repeatedTestId('privacy-policy-mail-link', 'verantwortlicher')}>{CONTROLLER.email}</a>
          </span>
        </address>
        <p>
          For all questions about data protection and to exercise your rights,
          contact us at the e-mail address above or by post, marked
          "Datenschutz" (data protection).
        </p>
      </>
    ),
  },
  {
    id: 'geltungsbereich',
    title: 'Scope',
    body: (
      <>
        <p>
          This privacy policy applies to the ProGeo monitoring portal (this web
          application), including the related notifications by e-mail, SMS
          and messenger, and to the ProGeo chat, our own chat server. Our
          customers use the portal to monitor buildings and structures, in
          particular to locate leaks and moisture.
        </p>
        <p>
          The readings recorded by our sensors (e.g. resistance and moisture
          values) relate to buildings and are generally not personal data.
          Personal data are, in particular, the data of the portal's users and
          the contact details of the contact persons for the monitored objects.
        </p>
      </>
    ),
  },
  {
    id: 'bereitstellung',
    title: 'Providing the application and server logs',
    body: (
      <>
        <p>
          Every time the portal is accessed, our server processes technically
          necessary data that your browser transmits automatically:
        </p>
        <ul>
          <li>IP address of the requesting device</li>
          <li>date and time of the request</li>
          <li>requested address (URL), HTTP status code and amount of data transferred</li>
          <li>previously visited page (referrer), browser type and operating system</li>
        </ul>
        <Facts
          purpose="Delivering the application, ensuring stability and security, detecting and preventing attacks, and error analysis."
          legalBasis="Art. 6(1)(f) GDPR. Our legitimate interest lies in the secure and uninterrupted operation of the application."
          retention="Server logs are deleted automatically from our log system after 30 days. Data that has to be kept to investigate a specific security incident is kept until the investigation is closed."
        />
        <h3>Error analysis and operational monitoring</h3>
        <p>
          When an error occurs in the application, the server sends an error
          report (error message, affected function, technical context) to an
          error log that we operate ourselves. By default, no personal
          identifiers such as IP addresses or sign-in data are sent; in
          individual cases, however, a report may contain e.g. a user name.
          For operational monitoring we also record technical metrics (e.g.
          response times, number of messages sent) without personal reference.
        </p>
        <Facts
          purpose="Detecting and fixing errors, ensuring operation."
          legalBasis="Art. 6(1)(f) GDPR. Our legitimate interest lies in the error-free operation of the monitoring."
          retention="Error reports are deleted as soon as they are no longer needed to fix the error."
        />
        <h3>Encryption</h3>
        <p>
          The connection to the portal is encrypted with TLS (recognisable by
          "https://" and the lock symbol in your browser's address bar). We
          store passwords only as a cryptographic hash, never in plain text.
        </p>
      </>
    ),
  },
  {
    id: 'konto',
    title: 'User account and sign-in',
    body: (
      <>
        <p>
          Using the portal requires a user account. Accounts are created by us
          or by an administrator of your company. We process:
        </p>
        <ul>
          <li>user name, first and last name, e-mail address</li>
          <li>
            optional: mobile number for SMS notifications, and the messenger
            you chose with your address there (Signal or WhatsApp number or
            Matrix ID)
          </li>
          <li>password (stored only as a hash)</li>
          <li>
            with two-factor authentication: the secret key of your
            authenticator app (encrypted) and your recovery codes (only as a
            hash)
          </li>
          <li>
            affiliation with your company, roles and permissions, and the
            objects and notification settings assigned to you
          </li>
          <li>time of account creation and of the last sign-in</li>
          <li>language setting - it also determines the language of your e-mails and messenger messages</li>
        </ul>
        <Facts
          purpose="Providing the portal, sign-in, permission management and delivery of the notifications you requested."
          legalBasis="Art. 6(1)(b) GDPR insofar as you are our contractual partner yourself. If you use the portal as an employee of a customer, the legal basis is Art. 6(1)(f) GDPR - our legitimate interest and that of your employer lies in providing the portal to its employees as agreed in the contract."
          retention="For as long as your user account exists. After the account is deleted, the data is deleted unless statutory retention obligations apply. In backups it remains until they are overwritten in the regular cycle."
        />
        <h3>Sign-in links, password reset and protection against misuse</h3>
        <p>
          On request we send you a one-time sign-in link by e-mail;
          invitations and password resets (only with two-factor
          authentication) also use such links. Users of our previous platform
          receive a one-time info e-mail about the move with a link to set their
          password and sign in; we record when it was sent and used. We store
          only a hash of the
          link, its validity and the time it was used, not the link itself;
          in the sending log it appears masked. The language selected on the
          page that requests the link determines the language of the e-mail.
          We count failed sign-in attempts per user name and per IP address
          for 15 minutes to prevent password guessing.
        </p>
        <Facts
          purpose="Secure sign-in without a password, protection of your account, aggregated evaluation of how often sign-in links are used."
          legalBasis="Art. 6(1)(b) or (f) GDPR (as for the user account)."
          retention="Failed attempts: 15 minutes. Unused links expire after their validity (minutes to a few days) and are replaced by new ones; the time a link was used is kept for as long as the user account exists."
        />
        <h3>Access request</h3>
        <p>
          With the "Request access" form you can request a user account. We
          process your first and last name, company, e-mail address, phone
          number (optional), project and your message, the selected language
          (for our e-mails to you), and the time at which you acknowledged
          this privacy policy. You confirm your e-mail address with a link
          (double opt-in); our staff then review the request.
        </p>
        <Facts
          purpose="Reviewing the request and setting up a user account."
          legalBasis="Art. 6(1)(b) GDPR (pre-contractual measure at your request)."
          retention="Unconfirmed requests are deleted after 7 days, rejected requests after 90 days. After approval, the periods of the user account apply."
        />
        <h3>Support access</h3>
        <p>
          To help with questions and faults, selected ProGeo administrators can
          view the portal from the perspective of your user account ("log in
          as"). Every such access is logged with the time and the acting
          person. We do not learn your password, and the time of your last
          sign-in remains unchanged.
        </p>
        <h3>Logging of actions</h3>
        <p>
          For traceability and to protect against misuse, we log sign-ins and
          security- or operation-relevant actions in the portal (e.g. handling
          alarms, controlling devices, backups, file uploads). We store the
          user account, the company, the time, the function used and the data
          entered or file names. Passwords are not logged.
        </p>
        <Facts
          purpose="Traceability of changes to alarms and devices, error analysis, detection of misuse."
          legalBasis="Art. 6(1)(f) GDPR. Our legitimate interest lies in the security and traceability of the monitoring operation."
          retention="As long as necessary for these purposes, at most until the end of the contractual relationship with your company."
        />
      </>
    ),
  },
  {
    id: 'objektdaten',
    title: 'Object and contact data',
    body: (
      <>
        <p>
          For every monitored object we store the object address and
          coordinates and the contact details of contact persons (name, phone
          number, e-mail address) - both on the customer side and the
          responsible ProGeo staff.
        </p>
        <p>
          We usually do not receive this data from the contact persons
          themselves but from our customer when placing the order or setting
          up the object (Art. 14 GDPR).
        </p>
        <Facts
          purpose="Performing the monitoring contract, contacting people in the event of an alarm or fault, coordinating service visits."
          legalBasis="Art. 6(1)(b) GDPR towards our contractual partners; otherwise Art. 6(1)(f) GDPR. The legitimate interest lies in reaching the responsible persons quickly in the event of damage to the object."
          retention="For the duration of the monitoring contract; then deleted unless statutory retention obligations apply."
          recipients="Users who have access to the respective object."
        />
      </>
    ),
  },
  {
    id: 'benachrichtigungen',
    title: 'Notifications by e-mail, SMS and messenger',
    body: (
      <>
        <p>
          Depending on your settings, the portal informs you by e-mail, SMS
          and/or messenger (ProGeo chat, Signal or WhatsApp) about alarms,
          connection failures of measuring systems, reports and test messages.
          For this we process your e-mail address, mobile number or messenger
          address, your language setting and the content of the message (e.g.
          object name, project number and type of event). Every message sent
          is logged with recipient, content and delivery status; links for
          signing in or acknowledging appear masked in the log.
        </p>
        <h3>Staged notifications, acknowledging and unsubscribing</h3>
        <p>
          If an alarm remains unacknowledged or a fault persists, we remind
          the registered recipients at fixed intervals and involve the
          responsible ProGeo site manager in later stages; finally the case is
          escalated internally. We send fault notifications only between
          9 a.m. and 10 p.m., alarms at any time. For every case we log who
          was notified when, which messages could not be delivered, and who
          confirmed receipt, acknowledged an alarm or unsubscribed.
        </p>
        <p>
          Every notification e-mail contains a personal link to acknowledge or
          confirm and a link to unsubscribe; your e-mail program can also
          trigger the unsubscribe directly ("List-Unsubscribe"). We store only
          a hash of these links; they are valid for 60 days. Unsubscribing
          does not affect your portal access; we record the unsubscribe
          (address, object, type of notification, time) as proof.
        </p>
        <h3>E-mail and non-delivery reports</h3>
        <p>
          We send e-mails through our own mail server. If a receiving mail
          server reports an e-mail as undeliverable, we evaluate this automatic
          report and block a permanently undeliverable address for further
          messages until it is corrected.
        </p>
        <h3>SMS via Esendex</h3>
        <p>
          To send SMS we use the service provider Esendex (Esendex Limited,
          United Kingdom) as a processor. Esendex receives the mobile number
          and the message text. The transfer to the United Kingdom is based on
          the European Commission's adequacy decision (Art. 45 GDPR).
        </p>
        <h3>WhatsApp</h3>
        <p>
          If you choose WhatsApp, we send the messages through the WhatsApp
          Business Platform (Cloud API) of Meta Platforms Ireland Ltd., Merrion
          Road, Dublin 4, Ireland. Meta receives your phone number and the
          message text; processing by Meta Platforms, Inc. in the USA is
          possible. The transfer to the USA is based on the EU-U.S. Data
          Privacy Framework (Art. 45 GDPR) or the European Commission's
          standard contractual clauses (Art. 46 GDPR) (
          <ExternalLink href="https://www.whatsapp.com/legal/business-data-processing-terms">
            terms
          </ExternalLink>
          ).
        </p>
        <h3>Signal</h3>
        <p>
          If you choose Signal, we send the messages from ProGeo's Signal
          number through our own chat server to your Signal number. Delivery
          is handled by the Signal service (Signal Messenger LLC, USA). The
          messages are end-to-end encrypted on their way to you; Signal does,
          however, receive your phone number as the recipient address (
          <ExternalLink href="https://signal.org/legal/">Signal's privacy policy</ExternalLink>
          ).
        </p>
        <Facts
          purpose="Delivering alarm and status messages, reminders until the fault is fixed or the alarm is acknowledged; proof of successful or failed delivery, of acknowledgements and of unsubscribes."
          legalBasis="Art. 6(1)(b) or (f) GDPR (as for the user account). The notifications are an essential part of the monitoring service. Choosing SMS and messenger is voluntary."
          retention="Sending logs, notification cases and unsubscribes are kept for the duration of the monitoring contract to be able to prove the delivery of alarm messages. Blocked addresses stay blocked until they are corrected."
          recipients="Esendex (SMS) as a processor under Art. 28 GDPR; depending on your choice, Meta (WhatsApp) or Signal."
        />
      </>
    ),
  },
  {
    id: 'chat',
    title: 'ProGeo chat (Matrix)',
    body: (
      <>
        <p>
          The ProGeo chat is a chat server based on the open Matrix standard,
          which we operate ourselves. Using it is voluntary. You sign in to a
          chat app with your ProGeo account - through the portal's sign-in
          page or with a QR code in your profile that allows a one-time sign-in
          valid for 10 minutes (we store only a hash of it and the time it was
          used). Your chat account is created on the first sign-in.
        </p>
        <p>On our chat server we process:</p>
        <ul>
          <li>your Matrix ID (derived from your user name) and your display name</li>
          <li>your signed-in devices and sessions with their IP addresses and app names</li>
          <li>
            your chats and messages, including the notifications of our
            system; the portal shows the time of your last sign-in to a chat
            app in your profile
          </li>
        </ul>
        <p>
          Messages from our notification system are not end-to-end encrypted:
          they are transmitted encrypted but are readable on our server. Chats
          between users are end-to-end encrypted by the app.
        </p>
        <p>
          You install the chat app yourself from the App Store or Google Play;
          we recommend Element X (Element Creations Ltd., United Kingdom). When
          you open our setup link or QR code, your device loads a page from
          Element (mobile.element.io) that opens the app with our server. So
          that you receive messages even when the app is closed, our server
          forwards push notifications through the app vendor's push service to
          Apple or Google; only technical identifiers (e.g. message and chat
          IDs) are transmitted. The privacy policies of the respective vendors
          apply to the app and these services (
          <ExternalLink href="https://element.io/privacy">Element</ExternalLink>
          ).
        </p>
        <Facts
          purpose="Providing the chat and delivering notifications by messenger."
          legalBasis="Art. 6(1)(b) or (f) GDPR (as for the user account)."
          retention="For as long as your user account exists. If your portal account is deactivated, the chat account is deactivated too; if it is deleted, we delete the chat account including its content. The chat server keeps your devices' IP addresses for at most 28 days. For technical reasons the Matrix ID itself is never assigned again."
          recipients="No disclosure of content; technical push identifiers to your app's push service and to Apple or Google."
        />
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies and local storage',
    body: (
      <>
        <p>
          The portal only uses technically necessary cookies and browser
          storage. We do not use analytics, tracking or advertising cookies.
        </p>
        <div className="privacy-table-wrap">
          <table className="privacy-table" data-testid="privacy-policy-cookie-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Purpose</th>
                <th>Duration</th>
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
          purpose="Providing the application you explicitly requested and protecting your account."
          legalBasis="Section 25(2) no. 2 TDDDG (storage is strictly necessary) in conjunction with Art. 6(1)(b) or (f) GDPR."
          retention="See table."
        />
      </>
    ),
  },
  {
    id: 'kartendienste',
    title: 'External map services (only with consent)',
    body: (
      <>
        <p>
          To show object locations, the portal can load map tiles from
          external providers. This happens <strong>only if you have given your
          consent</strong>; without consent, locations are shown without a map
          background.
        </p>
        <ul>
          <li>
            <strong>OpenStreetMap</strong> - OpenStreetMap Foundation, St John's
            Innovation Centre, Cowley Road, Cambridge, CB4 0WS, United Kingdom (
            <ExternalLink href="https://osmfoundation.org/wiki/Privacy_Policy">privacy policy</ExternalLink>
            )
          </li>
          <li>
            <strong>Esri ArcGIS Online</strong> (satellite images and place labels) - Environmental
            Systems Research Institute, Inc., 380 New York Street, Redlands, CA
            92373, USA (
            <ExternalLink href="https://www.esri.com/en-us/privacy/overview">privacy policy</ExternalLink>
            )
          </li>
        </ul>
        <p>
          When the maps load, your browser sends your IP address, the
          requested map section and browser information directly to the
          respective provider. Data may be transferred to third countries, in
          particular the USA. Where there is no adequacy decision of the
          European Commission for the recipient country or the provider is not
          certified under the EU-U.S. Data Privacy Framework, the transfer is
          based on your explicit consent (Art. 49(1)(a) GDPR). In that case
          there is a risk that authorities of the third country access the
          data without equivalent legal remedies being available to you.
        </p>
        <Facts
          purpose="Showing object locations on a map."
          legalBasis="Your consent under Section 25(1) TDDDG and Art. 6(1)(a) GDPR."
          retention="We do not store any data ourselves. The providers' privacy policies apply to their processing."
          recipients="OpenStreetMap Foundation, Esri Inc. (each as an independent controller)."
        />
        <div className="privacy-callout">
          <strong>Withdraw your consent at any time</strong>
          <p>
            You can change your choice at any time with effect for the future
            - in the info menu (i) in the header or directly here:
          </p>
          {consentButton}
        </div>
      </>
    ),
  },
  {
    id: 'nutzungsstatistik',
    title: 'Usage statistics (only with consent)',
    body: (
      <>
        <p>
          <strong>Only if you have consented to "usage statistics"</strong>, we
          record how you use the portal in order to improve it (e.g. which
          functions are needed and where steps take too long). Without consent
          your browser sends nothing for this.
        </p>
        <p>
          For signed-in users we store on our server, <strong>related to your
          user account</strong>:
        </p>
        <ul>
          <li>
            the pages visited (without identifiers, e.g. "object - analysis"
            instead of the object's number) and how long the page was visible,
          </li>
          <li>buttons and controls clicked - only their technical name, never texts or input,</li>
          <li>the times of your sign-ins,</li>
          <li>a random identifier per browser tab to recognise related page views.</li>
        </ul>
        <p>
          We store neither your IP address nor information about your browser
          or device, set no cookies and pass nothing on to third parties.
          Accounts of our employees are not recorded. We evaluate the data in
          aggregated form (e.g. views and time spent per page); it is not used
          to monitor the performance or behaviour of individual persons.
        </p>
        <p>
          <strong>Public demo:</strong> for every visit through a demo link we
          also record the demo link used, the start and the time of the last
          activity, the number of requests to the server and the browser's
          language setting. This information arises anyway when providing the
          demo. With your consent, your browser also sends a short activity
          signal in the demo about every 30 seconds while the tab is visible
          and you use the demo; from this we determine the active usage time
          and the areas visited. This data is evaluated per demo link.
        </p>
        <Facts
          purpose="Evaluating how and how long the portal and the demo are used in order to improve them."
          legalBasis="Your consent under Section 25(1) TDDDG and Art. 6(1)(a) GDPR. Recording of demo visits: our legitimate interest in evaluating the demo (Art. 6(1)(f) GDPR)."
          retention="Page views, clicks and sign-ins are deleted automatically after 180 days. Demo visits: as long as the respective demo link is evaluated."
        />
        <div className="privacy-callout">
          <strong>Withdraw your consent at any time</strong>
          <p>
            You can withdraw your consent at any time with effect for the
            future in the privacy settings - in the info menu (i) in the header
            or at the top of this page. From then on your browser sends no
            more usage data.
          </p>
        </div>
      </>
    ),
  },
  {
    id: 'empfaenger',
    title: 'Recipients and processors',
    body: (
      <>
        <p>
          We pass on personal data only insofar as this is necessary for the
          purposes described above. Service providers that process data on our
          behalf (e.g. for hosting, server maintenance and sending SMS) have
          been carefully selected and contractually bound under Art. 28 GDPR;
          they may use the data only according to our instructions.
        </p>
        <p>
          Within your company, the users who have access to the same objects
          or have administration rights see your data.
        </p>
        <p>
          For weather data (precipitation, to put alarms into context) our
          server sends the coordinates of the objects concerned to Open-Meteo
          (open-meteo.com); no data of users is transmitted.
        </p>
        <p>
          We do not sell data, do not use it for advertising and do not create
          user profiles for advertising purposes.
        </p>
      </>
    ),
  },
  {
    id: 'speicherdauer',
    title: 'Retention and backups',
    body: (
      <>
        <p>
          We store personal data only as long as necessary for the respective
          purpose or as required by statutory retention obligations (in
          particular under commercial and tax law, up to ten years). You will
          find the specific periods in the respective sections.
        </p>
        <p>
          To protect against data loss, we create backups every day and
          transfer them encrypted to a separate backup server, where they are
          replaced by newer ones after 14 days. Deleted data may remain in
          backups until they are overwritten in the regular cycle; it is not
          used for other purposes during this time.
        </p>
        <p>
          Before we put changes to the application into operation, we test
          them on our own test system with an encrypted copy of the data;
          only the two most recent copies are kept there. The test system is
          protected like the portal and sends no messages to customers (Art.
          6(1)(f) GDPR - our legitimate interest in the error-free operation
          of the monitoring).
        </p>
      </>
    ),
  },
  {
    id: 'rechte',
    title: 'Your rights',
    body: (
      <>
        <p>You have the following rights regarding your data:</p>
        <ul>
          <li>right of access (Art. 15 GDPR)</li>
          <li>right to rectification (Art. 16 GDPR)</li>
          <li>right to erasure (Art. 17 GDPR)</li>
          <li>right to restriction of processing (Art. 18 GDPR)</li>
          <li>right to data portability (Art. 20 GDPR)</li>
          <li>
            right to withdraw consent with effect for the future (Art. 7(3)
            GDPR); the lawfulness of processing carried out before the
            withdrawal remains unaffected
          </li>
        </ul>
        <p>
          Simply contact{' '}
          <a href={`mailto:${CONTROLLER.email}`} {...repeatedTestId('privacy-policy-mail-link', 'rechte')}>{CONTROLLER.email}</a>.
          You can also change your name, e-mail address, mobile number,
          messenger and language yourself at any time in your profile in the
          portal; you can unsubscribe from notifications with the link in
          every notification e-mail.
        </p>
        <div className="privacy-callout">
          <strong>Right to object under Art. 21 GDPR</strong>
          <p>
            Where we process your data on the basis of legitimate interests
            (Art. 6(1)(f) GDPR), you have the right to object to this
            processing at any time on grounds relating to your particular
            situation. We will then no longer process the data unless we can
            demonstrate compelling legitimate grounds that override your
            interests, rights and freedoms, or the processing serves the
            establishment, exercise or defence of legal claims.
          </p>
        </div>
      </>
    ),
  },
  {
    id: 'beschwerde',
    title: 'Right to lodge a complaint with a supervisory authority',
    body: (
      <>
        <p>
          You have the right to lodge a complaint with a data protection
          supervisory authority (Art. 77 GDPR), in particular in the member
          state of your habitual residence, your place of work or the place of
          the alleged infringement. The supervisory authority responsible for
          us is:
        </p>
        <address className="privacy-address">
          <strong>
            Die Landesbeauftragte für den Datenschutz und für das Recht auf
            Akteneinsicht Brandenburg
          </strong>
          <span>Stahnsdorfer Damm 77</span>
          <span>14532 Kleinmachnow, Germany</span>
          <span>
            <ExternalLink href="https://www.lda.brandenburg.de">www.lda.brandenburg.de</ExternalLink>
          </span>
        </address>
      </>
    ),
  },
  {
    id: 'sonstiges',
    title: 'Obligation to provide data, automated decisions',
    body: (
      <>
        <p>
          Your name and e-mail address are required to use the portal; without
          them no user account can be set up. Providing a mobile number or
          messenger address and using the ProGeo chat are voluntary and only
          needed for notifications through these channels.
        </p>
        <p>
          There is no automated decision-making, including profiling, within
          the meaning of Art. 22 GDPR. Alarms are triggered automatically, but
          they are based exclusively on readings of the monitored structures.
        </p>
      </>
    ),
  },
  {
    id: 'aenderungen',
    title: 'Changes to this privacy policy',
    body: (
      <p>
        We adapt this privacy policy whenever the application or the legal
        requirements change. The version published here applies. Last
        updated: {PRIVACY_POLICY_LAST_UPDATED}.
      </p>
    ),
  },
];
