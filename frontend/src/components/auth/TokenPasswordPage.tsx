import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Spinner } from 'react-bootstrap';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../../axiosConfig';
import { repeatedTestId } from '../../testIds';
import AuthPage, { AuthLinks, authButtonClass } from './AuthPage';

/**
 * The parts every "choose your password" mail link shares (VerifyAccess,
 * PasswordResetConfirm, MigrationSetup): the token is only checked on load -
 * no side effect, mail scanners open every link - and the password is set on
 * the button press. Each page keeps its own API, texts and test ids
 * (`testId` below is their prefix, e.g. "password-reset").
 */

type TokenState = 'checking' | 'invalid' | 'ready';

/** POSTs the token to `checkUrl` once: `identity` is the answer's `identityField`. */
export const useTokenCheck = (
  token: string | undefined,
  checkUrl: string,
  identityField: 'username' | 'email',
) => {
  const [state, setState] = useState<TokenState>(token ? 'checking' : 'invalid');
  const [identity, setIdentity] = useState('');
  const [firstName, setFirstName] = useState('');

  useEffect(() => {
    if (!token) {
      return;
    }
    void axiosConfig.perform_post(
      undefined,
      checkUrl,
      { token },
      (response) => {
        setIdentity(response.data[identityField] || '');
        setFirstName(response.data.first_name || '');
        setState('ready');
      },
      () => setState('invalid'),
    );
  }, [token, checkUrl, identityField]);

  return { state, setState, identity, firstName };
};

type RequestError = {
  response?: { status?: number; data?: { reason?: string; errors?: string[] } };
};

type SuccessResponse = { data: { access: string; refresh: string; forward?: string } };
// The page's own failures need the full error (2FA: otp_required as a flag).
type FailureError = RequestError & {
  response?: { data?: { otp_required?: boolean } };
};

/**
 * The new password twice, the errors and the busy flag - and `submit`,
 * which checks that both entries match and then POSTs `body` to `url`.
 * `fieldProps` goes onto NewPasswordForm.
 */
export const useNewPassword = () => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = (
    event: FormEvent,
    url: string,
    body: Record<string, unknown>,
    onSuccess: (response: SuccessResponse) => void,
    onFailure: (err: FailureError | undefined) => void,
  ) => {
    event.preventDefault();
    if (password !== repeat) {
      setErrors([t('access_verify_mismatch')]);
      return;
    }
    setErrors([]);
    setBusy(true);
    void axiosConfig.perform_post(undefined, url, body, onSuccess, (err) => {
      setBusy(false);
      onFailure(err);
    });
  };

  return {
    password,
    setErrors,
    submit,
    fieldProps: { password, onPassword: setPassword, repeat, onRepeat: setRepeat, errors, busy },
  };
};

/**
 * The failures every page answers alike: the password's rule errors, an
 * expired token (null - show the invalid state), too many tries, else
 * `fallbackKey`. Page-specific reasons (the 2FA code) are handled first.
 */
export const passwordFailure = (
  err: RequestError | undefined,
  t: TFunction,
  fallbackKey: string,
): string[] | null => {
  const data = err?.response?.data || {};
  if (data.reason === 'password') {
    return data.errors?.length ? data.errors : [t('access_verify_password_invalid')];
  }
  if (data.reason === 'invalid_token') {
    return null;
  }
  if (err?.response?.status === 429) {
    return [t('auth_too_many_requests')];
  }
  return [t(fallbackKey)];
};

/** "Checking the link ..." and "the link is no longer valid" (`children`: the way on). */
export const TokenStatePage = ({
  state,
  title,
  pageTestId,
  testId,
  invalidMessage,
  children,
}: {
  state: 'checking' | 'invalid';
  title: string;
  pageTestId: string;
  testId: string;
  invalidMessage: string;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  return (
    <AuthPage title={title} testId={pageTestId}>
      {state === 'checking' ? (
        <p className="auth-muted" data-testid={`${testId}-checking`}>
          <Spinner animation="border" size="sm" className="me-2" />
          {t('access_verify_checking')}
        </p>
      ) : (
        <>
          <p className="auth-muted" data-testid={`${testId}-invalid`}>
            {invalidMessage}
          </p>
          <AuthLinks>{children}</AuthLinks>
        </>
      )}
    </AuthPage>
  );
};

/** The authenticator code field (users with 2FA). */
export const OtpField = ({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) => {
  const { t } = useTranslation();
  return (
    <label className="auth-label">
      <span className="progeo-field-label">{t('login_otp_code')}</span>
      <input
        type="text"
        autoComplete="one-time-code"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="progeo-control auth-field"
        data-testid={testId}
      />
    </label>
  );
};

/**
 * The form: the account (read only, for the password manager), the new
 * password twice, `children` (e.g. OtpField), the errors and the button.
 * Test ids: `${testId}-form`, -<identityKind>, -password, -repeat, -error, -submit.
 */
export const NewPasswordForm = ({
  testId,
  identityLabel,
  identityKind,
  identity,
  passwordLabel,
  password,
  onPassword,
  repeat,
  onRepeat,
  errors,
  busy,
  submitLabel,
  onSubmit,
  children,
}: {
  testId: string;
  identityLabel: string;
  identityKind: 'username' | 'email';
  identity: string;
  passwordLabel: string;
  password: string;
  onPassword: (value: string) => void;
  repeat: string;
  onRepeat: (value: string) => void;
  errors: string[];
  busy: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent) => void;
  children?: ReactNode;
}) => {
  const { t } = useTranslation();
  return (
    <form onSubmit={onSubmit} className="auth-form" data-testid={`${testId}-form`}>
      <label className="auth-label">
        <span className="progeo-field-label">{identityLabel}</span>
        <input
          type={identityKind === 'email' ? 'email' : 'text'}
          value={identity}
          readOnly
          autoComplete="username"
          className="progeo-control auth-field auth-field--readonly"
          data-testid={`${testId}-${identityKind}`}
        />
      </label>
      <label className="auth-label">
        <span className="progeo-field-label">{passwordLabel}</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          className="progeo-control auth-field"
          data-testid={`${testId}-password`}
        />
      </label>
      <label className="auth-label">
        <span className="progeo-field-label">{t('access_verify_repeat')}</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(event) => onRepeat(event.target.value)}
          className="progeo-control auth-field"
          data-testid={`${testId}-repeat`}
        />
      </label>
      {children}
      {errors.map((message) => (
        <p key={message} className="auth-error" {...repeatedTestId(`${testId}-error`, message)}>
          {message}
        </p>
      ))}
      <button
        type="submit"
        disabled={busy}
        className={authButtonClass(busy)}
        data-testid={`${testId}-submit`}
      >
        {submitLabel}
      </button>
    </form>
  );
};
