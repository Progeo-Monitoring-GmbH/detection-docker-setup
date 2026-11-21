import React from 'react';
import { Phone } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { errorReason, showErrorBar, showInfoBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import PhoneInput from '../components/ui/PhoneInput';
import { formatPhone, isValidE164 } from '../components/ui/phone';
import { isDemoReadOnlyError } from './demo';
import MatrixSetupModal, { type MatrixAccount } from './MatrixSetupModal';
import './NotificationChannelCard.css';

type MobileChannel = 'sms' | 'matrix';

type ProfileContact = {
  mobile?: string | null;
  messenger?: string | null;
  matrix?: MatrixAccount | null;
};

/** The channel the profile has now: the ProGeo chat once it is the messenger, else SMS. */
const currentChannel = (profile: ProfileContact): MobileChannel =>
  profile.messenger === 'matrix' ? 'matrix' : 'sms';

/**
 * "Benachrichtigungen aufs Handy" on the notifications tab: (1) the mobile
 * number (PhoneInput, E.164), (2) the channel - SMS (default) or the ProGeo
 * chat (Matrix, only where this server has it). Saving SMS switches it on
 * for every object the user gets notifications of
 * (/v1/user/notification-channel/); the chat opens its setup dialog, which
 * ends with the chat as primary channel. Replaces the former chat banner:
 * the chat is one option, not the only one.
 */
const NotificationChannelCard = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();

  const [loaded, setLoaded] = React.useState(false);
  const [mobile, setMobile] = React.useState('');
  const [savedMobile, setSavedMobile] = React.useState('');
  const [channel, setChannel] = React.useState<MobileChannel>('sms');
  const [savedChannel, setSavedChannel] = React.useState<MobileChannel>('sms');
  const [matrix, setMatrix] = React.useState<MatrixAccount | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [setupOpen, setSetupOpen] = React.useState(false);

  const apply = (data: ProfileContact) => {
    const number = data.mobile || '';
    const chosen = currentChannel(data);
    setMobile(number);
    setSavedMobile(number);
    setChannel(chosen);
    setSavedChannel(chosen);
    setMatrix(data.matrix || null);
  };

  React.useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => {
        const data = (response?.data || {}) as ProfileContact;
        apply(data);
        // Nothing set up yet: the form is open right away.
        setEditing(!data.mobile && currentChannel(data) === 'sms');
        setLoaded(true);
      },
      () => setLoaded(true),
    );
    // Once per mount - a token swap (2FA) must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) {
    return null;
  }

  const smsReady = channel === 'sms' && isValidE164(mobile);
  const canSave = !saving && (channel === 'matrix' ? !mobile || isValidE164(mobile) : smsReady);

  const save = () => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/notification-channel/',
      { mobile, channel },
      (response) => {
        const data = (response?.data || {}) as ProfileContact & { subscriptions?: number };
        setSaving(false);
        setSavedMobile(data.mobile || '');
        setMobile(data.mobile || '');
        setMatrix(data.matrix || matrix);
        if (channel === 'matrix') {
          // The setup dialog makes the chat the primary channel at its end.
          setSetupOpen(true);
        } else {
          setSavedChannel('sms');
          setEditing(false);
          showSuccessBar(enqueueSnackbar, t('channel_saved_sms', { count: data.subscriptions ?? 0 }));
        }
      },
      (error) => {
        setSaving(false);
        if (isDemoReadOnlyError(error)) {
          showInfoBar(enqueueSnackbar, t('demo_read_only'));
          return;
        }
        const code = error?.response?.data?.code as string | undefined;
        const known = code && ['phone_invalid', 'mobile_required'].includes(code);
        showErrorBar(enqueueSnackbar, `${t('channel_save_error')}: ${known ? t(`channel_error_${code}`) : errorReason(error)}`);
      },
    );
  };

  const options = [
    { value: 'sms', label: t('channel_sms') },
    ...(matrix ? [{ value: 'matrix', label: t('channel_matrix') }] : []),
  ];

  return (
    <PanelCard testId="notification-channel" title={t('channel_title')}>
      {!editing ? (
        <div className="channel-summary" data-testid="notification-channel-summary">
          <Phone size={18} className="channel-summary-icon" aria-hidden="true" />
          <span className="channel-summary-text">
            {savedChannel === 'matrix'
              ? t('channel_summary_matrix', { id: matrix?.user_id || '' })
              : t('channel_summary_sms', { number: formatPhone(savedMobile) })}
          </span>
          <PillButton
            variant="surface"
            onClick={() => setEditing(true)}
            testId="notification-channel-change"
            label={t('channel_change')}
          />
        </div>
      ) : (
        <div className="channel-form" data-testid="notification-channel-form">
          <p className="channel-intro">{t('channel_intro')}</p>
          <div className="channel-step">
            <span className="channel-step-number">1</span>
            <div className="channel-step-body">
              <PhoneInput
                label={t('channel_mobile')}
                value={mobile}
                onChange={setMobile}
                testId="notification-channel-mobile"
              />
            </div>
          </div>
          <div className="channel-step">
            <span className="channel-step-number">2</span>
            <div className="channel-step-body">
              <span className="progeo-field-label">{t('channel_choose')}</span>
              <SegmentedControl
                options={options}
                value={channel}
                onChange={(value) => setChannel(value as MobileChannel)}
                testId="notification-channel-choice"
              />
              <span className="channel-hint" data-testid="notification-channel-hint">
                {channel === 'matrix' ? t('channel_matrix_hint') : t('channel_sms_hint')}
              </span>
            </div>
          </div>
          <div className="channel-actions">
            <PillButton
              variant="accent"
              onClick={save}
              disabled={!canSave}
              testId="notification-channel-save"
              label={channel === 'matrix' ? t('channel_save_matrix') : t('channel_save')}
            />
            {(savedMobile || savedChannel === 'matrix') && (
              <PillButton
                variant="surface"
                onClick={() => {
                  setMobile(savedMobile);
                  setChannel(savedChannel);
                  setEditing(false);
                }}
                testId="notification-channel-cancel"
                label={t('rechte_cancel')}
              />
            )}
          </div>
        </div>
      )}
      {matrix && (
        <MatrixSetupModal
          show={setupOpen}
          initialStep={matrix.connected_at ? 3 : 1}
          onHide={() => setSetupOpen(false)}
          account={matrix}
          onConnected={(connectedAt) => setMatrix((current) => (current ? { ...current, connected_at: connectedAt } : current))}
          onPrimary={() => {
            setMatrix((current) => (current ? { ...current, primary: true } : current));
            setSavedChannel('matrix');
            setEditing(false);
          }}
        />
      )}
    </PanelCard>
  );
};

export default NotificationChannelCard;
