import React from 'react';
import { Spinner } from 'react-bootstrap';
import { Clipboard, Download } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  errorReason,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import LabeledInput from '../components/ui/kit/LabeledInput';
import PillButton from '../components/ui/kit/PillButton';
import { recoveryCodesText, serverErrorText } from './twoFactor';

type TwoFactorStatus = {
  enabled: boolean;
  /** Mandatory for this user (staff with TWO_FACTOR_REQUIRED_FOR_STAFF). */
  required: boolean;
  recovery_codes_left: number;
  has_usable_password: boolean;
};

type TwoFactorSetup = {
  secret: string;
  otpauth_uri: string;
  /** data:image/png;base64,... */
  qr_code: string;
};

type CodeAction = 'disable' | 'recovery';

const panelStyle: React.CSSProperties = {
  background: 'var(--progeo-surface)',
  borderRadius: 14,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const hintStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: '#8B8383',
  margin: 0,
};

const errorStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: '#b42318',
  margin: 0,
};

/**
 * The recovery codes - shown once, right after they were generated; the
 * backend only keeps their hashes.
 */
export const RecoveryCodes = ({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) => {
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const text = recoveryCodesText(t('tfa_recovery_title'), codes);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => showSuccessBar(enqueueSnackbar, t('tfa_recovery_copied')));
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'progeo-wiederherstellungscodes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ ...panelStyle, border: '1px solid var(--progeo-orange)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t('tfa_recovery_title')}</div>
      <p style={{ ...hintStyle, color: '#C44D26' }}>{t('tfa_recovery_hint')}</p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 16px',
          fontFamily: 'monospace',
          fontSize: 14,
        }}
      >
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <PillButton label={t('tfa_recovery_copy')} icon={<Clipboard size={13} />} onClick={copy} />
        <PillButton label={t('tfa_recovery_download')} icon={<Download size={13} />} onClick={download} />
        <PillButton label={t('tfa_recovery_done')} onClick={onDone} />
      </div>
    </div>
  );
};

/**
 * "Zwei-Faktor-Anmeldung" (TOTP): set up with an authenticator app, turn
 * off, new recovery codes. Used in the profile drawer and on the page of
 * staff who have to set it up first (TwoFactorSetupRequired). Enabling and
 * disabling end every other login of the user - the backend answers with a
 * fresh token pair for this device, which replaces the stored one.
 */
const TwoFactorSettings = ({
  onEnabledChange,
}: {
  onEnabledChange?: (enabled: boolean) => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();

  const [status, setStatus] = React.useState<TwoFactorStatus | null>(null);
  const [password, setPassword] = React.useState('');
  const [setup, setSetup] = React.useState<TwoFactorSetup | null>(null);
  const [codeAction, setCodeAction] = React.useState<CodeAction | null>(null);
  const [code, setCode] = React.useState('');
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/user/2fa/',
      (response) => setStatus(response.data as TwoFactorStatus),
      (err) => showRequestError(enqueueSnackbar, t('tfa_load_error'), err),
    );
    // Reloads after a token swap (2FA change); not on every new auth object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.token]);

  const fail = (err) => {
    setError(serverErrorText(t, err, String(errorReason(err) || '') || t('tfa_error')));
    setBusy(false);
  };

  const begin = () => {
    setError('');
    setBusy(true);
  };

  const resetForms = () => {
    setSetup(null);
    setCodeAction(null);
    setCode('');
    setPassword('');
    setError('');
  };

  const startSetup = () => {
    begin();
    void axiosConfig.perform_post(
      auth,
      '/v1/user/2fa/setup/',
      status?.has_usable_password ? { password } : {},
      (response) => {
        setSetup(response.data as TwoFactorSetup);
        setPassword('');
        setCode('');
        setBusy(false);
      },
      fail,
    );
  };

  const confirmSetup = () => {
    begin();
    void axiosConfig.perform_post(
      auth,
      '/v1/user/2fa/confirm/',
      { code: code.trim() },
      (response) => {
        const codes = (response.data.recovery_codes || []) as string[];
        // Every other login of the user ended - this device continues with these.
        auth.loginWithTokens(response.data.access, response.data.refresh);
        setStatus((current) => current && { ...current, enabled: true, recovery_codes_left: codes.length });
        setRecoveryCodes(codes);
        resetForms();
        setBusy(false);
        showSuccessBar(enqueueSnackbar, t('tfa_enabled'));
        onEnabledChange?.(true);
      },
      fail,
    );
  };

  const submitCodeAction = () => {
    if (!codeAction) {
      return;
    }
    begin();
    if (codeAction === 'recovery') {
      void axiosConfig.perform_post(
        auth,
        '/v1/user/2fa/recovery-codes/',
        { code: code.trim() },
        (response) => {
          const codes = (response.data.recovery_codes || []) as string[];
          setStatus((current) => current && { ...current, recovery_codes_left: codes.length });
          setRecoveryCodes(codes);
          resetForms();
          setBusy(false);
        },
        fail,
      );
      return;
    }
    void axiosConfig.perform_post(
      auth,
      '/v1/user/2fa/disable/',
      { code: code.trim() },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        setStatus((current) => current && { ...current, enabled: false, recovery_codes_left: 0 });
        resetForms();
        setBusy(false);
        showSuccessBar(enqueueSnackbar, t('tfa_disabled'));
        onEnabledChange?.(false);
      },
      fail,
    );
  };

  if (!status) {
    return (
      <div className="d-flex align-items-center gap-2 text-muted">
        <Spinner animation="border" size="sm" /> {t('profile_loading')}
      </div>
    );
  }

  const codeInput = (
    <LabeledInput
      label={t('tfa_code')}
      value={code}
      onChange={setCode}
      autoComplete="one-time-code"
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 'var(--progeo-radius-pill)',
            background: status.enabled ? '#E3F4EA' : '#FBEAE4',
            color: status.enabled ? '#1E7B45' : '#C44D26',
          }}
        >
          {status.enabled ? t('tfa_status_on') : t('tfa_status_off')}
        </span>
        {status.enabled && (
          <span style={hintStyle}>
            {t('tfa_codes_left', { count: status.recovery_codes_left })}
          </span>
        )}
      </div>
      {!status.enabled && <p style={hintStyle}>{t('tfa_intro')}</p>}
      {status.required && <p style={hintStyle}>{t('tfa_required_hint')}</p>}

      {recoveryCodes && (
        <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />
      )}

      {!status.enabled && !setup && (
        <div style={panelStyle}>
          {status.has_usable_password && (
            <LabeledInput
              label={t('profile_current_password')}
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="current-password"
            />
          )}
          {error && <p style={errorStyle}>{error}</p>}
          <PillButton
            label={t('tfa_setup')}
            onClick={startSetup}
            disabled={busy || (status.has_usable_password && !password)}
          />
        </div>
      )}

      {!status.enabled && setup && (
        <div style={panelStyle}>
          <p style={hintStyle}>{t('tfa_scan')}</p>
          <img
            src={setup.qr_code}
            alt={t('tfa_qr_alt')}
            style={{ width: 180, height: 180, alignSelf: 'center', background: '#fff', borderRadius: 8 }}
          />
          <div>
            <p style={hintStyle}>{t('tfa_secret')}</p>
            <code style={{ fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }}>{setup.secret}</code>
          </div>
          {codeInput}
          {error && <p style={errorStyle}>{error}</p>}
          <div style={{ display: 'flex', gap: 4 }}>
            <PillButton label={t('tfa_confirm')} onClick={confirmSetup} disabled={busy || !code.trim()} />
            <PillButton label={t('tfa_cancel')} variant="ghost" onClick={resetForms} disabled={busy} />
          </div>
        </div>
      )}

      {status.enabled && !codeAction && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <PillButton label={t('tfa_recovery_regenerate')} onClick={() => setCodeAction('recovery')} />
          {!status.required && (
            <PillButton label={t('tfa_disable')} onClick={() => setCodeAction('disable')} />
          )}
        </div>
      )}

      {status.enabled && codeAction && (
        <div style={panelStyle}>
          <p style={hintStyle}>
            {codeAction === 'recovery' ? t('tfa_recovery_regenerate_hint') : t('tfa_disable_hint')}
          </p>
          {codeInput}
          {error && <p style={errorStyle}>{error}</p>}
          <div style={{ display: 'flex', gap: 4 }}>
            <PillButton
              label={codeAction === 'recovery' ? t('tfa_recovery_regenerate') : t('tfa_disable')}
              onClick={submitCodeAction}
              disabled={busy || !code.trim()}
            />
            <PillButton label={t('tfa_cancel')} variant="ghost" onClick={resetForms} disabled={busy} />
          </div>
        </div>
      )}
    </div>
  );
};

export default TwoFactorSettings;
