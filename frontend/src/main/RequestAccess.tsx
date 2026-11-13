import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from '../components/auth/AuthPage';
import { PRIVACY_POLICY_URL } from '../components/privacy/consent';
import { testId } from '../testIds';

type RequestForm = {
  first_name: string;
  last_name: string;
  company: string;
  email: string;
  phone: string;
  project: string;
  message: string;
  privacy_accepted: boolean;
  website: string;
};

const TEXT_FIELDS: {
  name: keyof RequestForm;
  label: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}[] = [
  {
    name: 'first_name',
    label: 'access_first_name',
    required: true,
    autoComplete: 'given-name',
  },
  {
    name: 'last_name',
    label: 'access_last_name',
    required: true,
    autoComplete: 'family-name',
  },
  {
    name: 'company',
    label: 'access_company',
    autoComplete: 'organization',
  },
  {
    name: 'email',
    label: 'access_email',
    type: 'email',
    required: true,
    autoComplete: 'email',
  },
  { name: 'phone', label: 'access_phone', type: 'tel', autoComplete: 'tel' },
  { name: 'project', label: 'access_project' },
];

/**
 * Public "Zugang beantragen" form (/zugang/beantragen). The backend mails a
 * confirmation link; only a confirmed request reaches the staff for review.
 * The answer is always the same "check your inbox", whether the address is
 * known or not. `website` is a honeypot - hidden from people, filled by bots.
 */
const RequestAccess = () => {
  const { t } = useTranslation();
  const { register, handleSubmit, formState } = useForm<RequestForm>({
    defaultValues: { privacy_accepted: false, website: '' },
  });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const onSubmit = async (data: RequestForm) => {
    setError('');
    setFieldErrors({});
    await axiosConfig.perform_post(
      undefined,
      '/api/auth-support/access-requests/',
      data,
      () => setSent(true),
      (err) => {
        const status = err?.response?.status;
        setFieldErrors(err?.response?.data?.fields || {});
        setError(
          status === 429
            ? t('auth_too_many_requests')
            : t('access_request_error'),
        );
      },
    );
  };

  if (sent) {
    return (
      <AuthPage title={t('access_request_sent_title')} testId="page-request-access">
        <p className="auth-muted" data-testid="request-access-sent">{t('access_request_sent_text')}</p>
        <AuthLinks>
          <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('access_request_title')}
      intro={t('access_request_intro')}
      testId="page-request-access"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="auth-form" data-testid="request-access-form">
        {TEXT_FIELDS.map((field) => (
          <label key={field.name} className="auth-label">
            <span className="auth-field-label">
              {t(field.label)}
              {!field.required && ` (${t('access_optional')})`}
            </span>
            <input
              type={field.type || 'text'}
              autoComplete={field.autoComplete}
              required={field.required}
              className="auth-field"
              data-testid={testId('request-access', field.name)}
              {...register(field.name)}
            />
            {fieldErrors[field.name] && (
              <p className="auth-error" data-testid={testId('request-access', field.name, 'error')}>{fieldErrors[field.name]}</p>
            )}
          </label>
        ))}

        <label className="auth-label">
          <span className="auth-field-label">
            {t('access_message')} ({t('access_optional')})
          </span>
          <textarea
            rows={3}
            className="auth-field auth-field--textarea"
            data-testid="request-access-message"
            {...register('message')}
          />
        </label>

        {/* Honeypot: off-screen and skipped by keyboard and autofill. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="auth-honeypot"
          data-testid="request-access-honeypot"
          {...register('website')}
        />

        <label className="auth-check">
          <input
            type="checkbox"
            required
            className="auth-check-input"
            data-testid="request-access-privacy-accepted"
            {...register('privacy_accepted')}
          />
          <span>
            {t('access_privacy_prefix')}{' '}
            <Link to={PRIVACY_POLICY_URL} data-testid="request-access-privacy-link">{t('consent_privacy_policy')}</Link>{' '}
            {t('access_privacy_suffix')}
          </span>
        </label>
        {fieldErrors.privacy_accepted && (
          <p className="auth-error" data-testid="request-access-privacy-accepted-error">{fieldErrors.privacy_accepted}</p>
        )}

        {error && <p className="auth-error" data-testid="request-access-error">{error}</p>}

        <button
          type="submit"
          disabled={formState.isSubmitting}
          className={authButtonClass(formState.isSubmitting)}
          data-testid="request-access-submit"
        >
          {t('access_request_submit')}
        </button>
      </form>

      <AuthLinks>
        <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default RequestAccess;
