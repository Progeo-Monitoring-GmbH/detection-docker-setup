import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../axiosConfig';
import AuthPage, {
  AuthLinks,
  ERROR_TEXT,
  FIELD,
  FIELD_LABEL,
  FORM,
  LABEL,
  MUTED_TEXT,
  buttonStyle,
} from '../components/auth/AuthPage';
import { PRIVACY_POLICY_URL } from '../components/privacy/consent';

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
    required: true,
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
      <AuthPage title={t('access_request_sent_title')}>
        <p style={MUTED_TEXT}>{t('access_request_sent_text')}</p>
        <AuthLinks>
          <Link to="/login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('access_request_title')}
      intro={t('access_request_intro')}
    >
      <form onSubmit={handleSubmit(onSubmit)} style={FORM}>
        {TEXT_FIELDS.map((field) => (
          <label key={field.name} style={LABEL}>
            <span style={FIELD_LABEL}>
              {t(field.label)}
              {!field.required && ` (${t('access_optional')})`}
            </span>
            <input
              type={field.type || 'text'}
              autoComplete={field.autoComplete}
              required={field.required}
              style={FIELD}
              {...register(field.name)}
            />
            {fieldErrors[field.name] && (
              <p style={ERROR_TEXT}>{fieldErrors[field.name]}</p>
            )}
          </label>
        ))}

        <label style={LABEL}>
          <span style={FIELD_LABEL}>
            {t('access_message')} ({t('access_optional')})
          </span>
          <textarea
            rows={3}
            style={{
              ...FIELD,
              height: 'auto',
              padding: '10px 13px',
              resize: 'vertical',
            }}
            {...register('message')}
          />
        </label>

        {/* Honeypot: off-screen and skipped by keyboard and autofill. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '-10000px',
            width: 1,
            height: 1,
            opacity: 0,
          }}
          {...register('website')}
        />

        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: 13,
            margin: 0,
          }}
        >
          <input
            type="checkbox"
            required
            style={{ marginTop: 3 }}
            {...register('privacy_accepted')}
          />
          <span>
            {t('access_privacy_prefix')}{' '}
            <Link to={PRIVACY_POLICY_URL}>{t('consent_privacy_policy')}</Link>{' '}
            {t('access_privacy_suffix')}
          </span>
        </label>
        {fieldErrors.privacy_accepted && (
          <p style={ERROR_TEXT}>{fieldErrors.privacy_accepted}</p>
        )}

        {error && <p style={ERROR_TEXT}>{error}</p>}

        <button
          type="submit"
          disabled={formState.isSubmitting}
          style={buttonStyle(formState.isSubmitting)}
        >
          {t('access_request_submit')}
        </button>
      </form>

      <AuthLinks>
        <Link to="/login">{t('auth_back_to_login')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default RequestAccess;
