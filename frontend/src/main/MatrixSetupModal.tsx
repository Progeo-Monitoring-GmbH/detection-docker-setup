import React from 'react';
import { Modal } from 'react-bootstrap';
import { Apple, CheckCircleFill, GooglePlay, Phone } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import { repeatedTestId } from '../testIds';
import './MatrixSetupModal.css';

export type SetupStep = 1 | 2 | 3;

type ChatApp = 'element_x' | 'fluffychat';

/** The user's account on our Matrix server (/v1/user/profile/ `matrix`, helper/matrix_accounts.account_info). */
export type MatrixAccount = {
  user_id: string;
  homeserver: string;
  /** Last login in a chat app (the portal handed MAS a token), ISO time. */
  connected_at?: string | null;
  /** Per app: the link behind its QR code and the code (PNG data URI). */
  apps: Record<ChatApp, { link: string; qr: string }>;
  /** Setup step 1: Element X (store, or the app with our server preset). */
  download?: { link: string; qr: string; stores: { ios?: string; android?: string } };
  /** Matrix is the user's messenger already. */
  primary?: boolean;
};

type QrLogin = { link: string; qr: string; expires_at: string; valid_seconds: number };

/** The low-poly clip of each step (scripts/tutorial/render_matrix_tutorial.py). */
const CLIPS: Record<SetupStep, string> = {
  1: '/assets/tutorial/matrix-step-1-install',
  2: '/assets/tutorial/matrix-step-2-scan',
  3: '/assets/tutorial/matrix-step-3-test',
};
const POLL_MS = 3000;

const Clip = ({ step }: { step: SetupStep }) => (
  <video
    key={step}
    className="matrix-setup-clip"
    autoPlay
    loop
    muted
    playsInline
    poster={`${CLIPS[step]}.png`}
    aria-hidden="true"
    data-testid="matrix-setup-clip"
  >
    <source src={`${CLIPS[step]}.webm`} type="video/webm" />
    <source src={`${CLIPS[step]}.mp4`} type="video/mp4" />
  </video>
);

const secondsLeft = (expiresAt: string | undefined, now: number) =>
  expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000)) : 0;

/**
 * "ProGeo Chat einrichten": the user's way to the Matrix notifications in
 * three animated steps - install Element X, scan the one-time login QR code
 * (no password: helper/matrix_accounts.create_qr_login), receive a test
 * message - and finally Matrix as the primary notification channel. The
 * dialog notices the app login by itself (polls /v1/user/matrix/).
 */
const MatrixSetupModal = ({
  show,
  onHide,
  account,
  initialStep = 1,
  onConnected,
  onPrimary,
}: {
  show: boolean;
  onHide: () => void;
  account: MatrixAccount;
  initialStep?: SetupStep;
  /** The app just signed in (ISO time of the login). */
  onConnected?: (connectedAt: string) => void;
  /** Matrix became the primary channel. */
  onPrimary?: () => void;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [step, setStep] = React.useState<SetupStep>(initialStep);
  const [qr, setQr] = React.useState<QrLogin | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [connected, setConnected] = React.useState(false);
  const [testSent, setTestSent] = React.useState(false);
  const [primary, setPrimary] = React.useState(Boolean(account.primary));
  const [busy, setBusy] = React.useState(false);
  const baseline = React.useRef<string | null>(account.connected_at || null);

  React.useEffect(() => {
    if (show) {
      setStep(initialStep);
      setConnected(false);
      setTestSent(false);
      setQr(null);
      setPrimary(Boolean(account.primary));
      baseline.current = account.connected_at || null;
    }
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const fetchQr = React.useCallback(() => {
    void axiosConfig.perform_post(
      auth,
      '/v1/user/matrix/qr/',
      {},
      (response) => {
        setQr(response.data as QrLogin);
        setNow(Date.now());
      },
      (error) => showErrorBar(enqueueSnackbar, `${t('matrix_setup_qr_error')}: ${error?.response?.data?.reason || ''}`),
    );
  }, [auth, enqueueSnackbar, t]);

  // Step 2: a fresh code, a countdown, and polling for the app login.
  React.useEffect(() => {
    if (!show || step !== 2) {
      return undefined;
    }
    fetchQr();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void axiosConfig.perform_get(
        auth,
        '/v1/user/matrix/',
        (response) => {
          const latest = (response?.data?.connected_at as string | null) || null;
          if (latest && latest !== baseline.current) {
            baseline.current = latest;
            setConnected(true);
            onConnected?.(latest);
            showSuccessBar(enqueueSnackbar, t('matrix_setup_connected'));
            setStep(3);
          }
        },
        () => {},
      );
    }, POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [auth, enqueueSnackbar, fetchQr, onConnected, show, step, t]);

  const remaining = secondsLeft(qr?.expires_at, now);
  const expired = qr !== null && remaining === 0;

  const sendTest = () => {
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/matrix/test/',
      {},
      () => {
        setBusy(false);
        setTestSent(true);
      },
      (error) => {
        setBusy(false);
        const code = error?.response?.data?.code as string | undefined;
        showErrorBar(enqueueSnackbar, code ? t(`matrix_setup_error_${code}`) : t('matrix_setup_test_failed'));
      },
    );
  };

  const makePrimary = () => {
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/matrix/primary/',
      {},
      (response) => {
        setBusy(false);
        setPrimary(true);
        onPrimary?.();
        showSuccessBar(enqueueSnackbar, t('matrix_setup_primary_done', { count: response.data.subscriptions ?? 0 }));
      },
      () => {
        setBusy(false);
        showErrorBar(enqueueSnackbar, t('matrix_setup_primary_failed'));
      },
    );
  };

  const steps: Array<{ id: SetupStep; label: string }> = [
    { id: 1, label: t('matrix_setup_step_install') },
    { id: 2, label: t('matrix_setup_step_scan') },
    { id: 3, label: t('matrix_setup_step_test') },
  ];
  const stores = account.download?.stores;

  return (
    <Modal show={show} onHide={onHide} size="lg" centered className="matrix-setup" data-testid="matrix-setup">
      <Modal.Header closeButton>
        <Modal.Title className="matrix-setup-title">{t('matrix_setup_title')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ol className="matrix-setup-steps" data-testid="matrix-setup-steps">
          {steps.map(({ id, label }) => (
            <li key={id} className={id === step ? 'is-active' : id < step ? 'is-done' : undefined}>
              <button type="button" onClick={() => setStep(id)} {...repeatedTestId('matrix-setup-step', id)}>
                <span className="matrix-setup-step-number">{id < step ? <CheckCircleFill size={14} /> : id}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>

        <div className="matrix-setup-body">
          <Clip step={step} />

          <div className="matrix-setup-content" data-testid={`matrix-setup-content-${step}`}>
            {step === 1 && (
              <>
                <h3 className="matrix-setup-heading">{t('matrix_setup_install_title')}</h3>
                <p>{t('matrix_setup_install_text')}</p>
                <div className="matrix-setup-stores">
                  {stores?.ios && (
                    <a href={stores.ios} target="_blank" rel="noreferrer" className="matrix-setup-store" data-testid="matrix-setup-store-ios">
                      <Apple size={18} /> App Store
                    </a>
                  )}
                  {stores?.android && (
                    <a href={stores.android} target="_blank" rel="noreferrer" className="matrix-setup-store" data-testid="matrix-setup-store-android">
                      <GooglePlay size={16} /> Google Play
                    </a>
                  )}
                </div>
                {account.download && (
                  <div className="matrix-setup-qr-row">
                    <img src={account.download.qr} alt={t('matrix_setup_download_qr_alt')} width={112} height={112} className="matrix-setup-qr" data-testid="matrix-setup-download-qr" />
                    <span className="matrix-setup-muted">{t('matrix_setup_download_qr_hint')}</span>
                  </div>
                )}
                <div className="matrix-setup-actions">
                  <PillButton label={t('matrix_setup_installed')} variant="accent" onClick={() => setStep(2)} testId="matrix-setup-next-1" />
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h3 className="matrix-setup-heading">{t('matrix_setup_scan_title')}</h3>
                <p>{t('matrix_setup_scan_text')}</p>
                <div className="matrix-setup-qr-row">
                  {qr && !expired ? (
                    <img src={qr.qr} alt={t('matrix_setup_login_qr_alt')} width={168} height={168} className="matrix-setup-qr" data-testid="matrix-setup-login-qr" />
                  ) : (
                    <div className="matrix-setup-qr matrix-setup-qr--empty" data-testid="matrix-setup-login-qr-empty">
                      {expired && (
                        <PillButton label={t('matrix_setup_new_code')} onClick={fetchQr} testId="matrix-setup-new-code" />
                      )}
                    </div>
                  )}
                  <div className="matrix-setup-qr-side">
                    {qr && !expired && (
                      <span className="matrix-setup-muted" data-testid="matrix-setup-countdown">
                        {t('matrix_setup_valid_for', { minutes: Math.floor(remaining / 60), seconds: String(remaining % 60).padStart(2, '0') })}
                      </span>
                    )}
                    {qr && !expired && (
                      <a href={qr.link} className="matrix-setup-open-here" data-testid="matrix-setup-open-here">
                        <Phone size={14} /> {t('matrix_setup_open_here')}
                      </a>
                    )}
                    <span className="matrix-setup-waiting" data-testid="matrix-setup-waiting">
                      {connected ? t('matrix_setup_connected') : t('matrix_setup_waiting')}
                    </span>
                  </div>
                </div>
                <details className="matrix-setup-manual">
                  <summary>{t('matrix_setup_manual_title')}</summary>
                  {t('matrix_setup_manual_text', { server: account.homeserver })}
                </details>
              </>
            )}

            {step === 3 && (
              <>
                <h3 className="matrix-setup-heading">{t('matrix_setup_test_title')}</h3>
                <p>{t('matrix_setup_test_text', { id: account.user_id })}</p>
                <div className="matrix-setup-actions">
                  <PillButton
                    label={testSent ? t('matrix_setup_test_again') : t('matrix_setup_test_send')}
                    variant={testSent ? 'ghost' : 'accent'}
                    disabled={busy}
                    onClick={sendTest}
                    testId="matrix-setup-test"
                  />
                </div>
                {testSent && (
                  <p className="matrix-setup-hint" data-testid="matrix-setup-test-sent">{t('matrix_setup_test_sent')}</p>
                )}
                <div className="matrix-setup-primary" data-testid="matrix-setup-primary">
                  {primary ? (
                    <span className="matrix-setup-ok"><CheckCircleFill size={15} /> {t('matrix_setup_is_primary')}</span>
                  ) : (
                    <>
                      <p className="mb-2">{t('matrix_setup_primary_text')}</p>
                      <PillButton
                        label={t('matrix_setup_primary_button')}
                        variant="accent"
                        disabled={busy}
                        onClick={makePrimary}
                        testId="matrix-setup-make-primary"
                      />
                    </>
                  )}
                </div>
                <div className="matrix-setup-actions">
                  <PillButton label={t('matrix_setup_done')} onClick={onHide} testId="matrix-setup-done" />
                </div>
              </>
            )}
          </div>
        </div>
      </Modal.Body>
    </Modal>
  );
};

export default MatrixSetupModal;
