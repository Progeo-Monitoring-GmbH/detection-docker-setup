import { useState } from 'react';
import { Link } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { currentLanguage } from '../components/ui/LanguageSwitch';
import axiosConfig from '../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from '../components/auth/AuthPage';
import { PRIVACY_POLICY_URL } from '../components/privacy/consent';
import { testId } from '../testIds';
import PhoneInput from '../components/ui/PhoneInput';
import { isPhoneSavable } from '../components/ui/phone';

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
  // Rendered as PhoneInput (calling code + number, E.164).
  { name: 'phone', label: 'access_phone' },
  { name: 'project', label: 'access_project' },
];

/**
 * Public "Zugang beantragen" form (/access/request). The backend mails a
 * confirmation link; only a confirmed request reaches the staff for review.
 * The answer is always the same "check your inbox", whether the address is
 * known or not. `website` is a honeypot - hidden from people, filled by bots.
 */
const RequestAccess = () => {
  const { t, i18n } = useTranslation();
  const { register, handleSubmit, formState, setValue, control } = useForm<RequestForm>({
    defaultValues: { privacy_accepted: false, website: '', phone: '' },
  });
  const phone = useWatch({ control, name: 'phone' });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const onSubmit = async (data: RequestForm) => {
    setError('');
    setFieldErrors({});
    if (!isPhoneSavable(data.phone)) {
      setFieldErrors({ phone: t('phone_invalid') });
      return;
    }
    await axiosConfig.perform_post(
      undefined,
      '/api/auth-support/access-requests/',
      // The language of the confirmation mail - and the preselection when staff decide.
      { ...data, language: currentLanguage(i18n.language) },
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
        {TEXT_FIELDS.map((field) => field.name === 'phone' ? (
          <div key={field.name}>
            <PhoneInput
              variant="auth"
              label={t(field.label)}
              labelSuffix={`(${t('access_optional')})`}
              value={phone || ''}
              onChange={(value) => setValue('phone', value)}
              testId="request-access-phone"
            />
            {fieldErrors.phone && (
              <p className="auth-error" data-testid="request-access-phone-error">{fieldErrors.phone}</p>
            )}
          </div>
        ) : (
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
            <Link to={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" data-testid="request-access-privacy-link">{t('consent_privacy_policy')}</Link>{' '}
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
