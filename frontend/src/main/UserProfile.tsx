import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Form,
  Modal,
  ProgressBar,
  Row,
  Spinner,
} from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showInfoBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import '../components/ui/css/CustomModal.css';

type UserProfileResponse = {
  username: string;
  email: string;
  language: string;
};

const isValidEmail = (input: string): boolean => {
  const value = input.trim();
  if (!value) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

type PasswordStrength = {
  score: number;
  level: 'very_weak' | 'weak' | 'medium' | 'strong' | 'very_strong';
  valid: boolean;
  checks: {
    minLength: boolean;
    lower: boolean;
    upper: boolean;
    digit: boolean;
    special: boolean;
    multipleCharsets: boolean;
  };
};

const evaluatePasswordStrength = (password: string): PasswordStrength => {
  const checks = {
    minLength: password.length >= 8,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /\d/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
    multipleCharsets: false,
  };

  const charsetCount = [
    checks.lower,
    checks.upper,
    checks.digit,
    checks.special,
  ].filter(Boolean).length;
  checks.multipleCharsets = charsetCount >= 3;

  const score = [
    checks.minLength,
    checks.lower,
    checks.upper,
    checks.digit,
    checks.special,
    checks.multipleCharsets,
  ].filter(Boolean).length;

  let level: PasswordStrength['level'] = 'very_weak';
  if (score >= 6) {
    level = 'very_strong';
  } else if (score >= 5) {
    level = 'strong';
  } else if (score >= 4) {
    level = 'medium';
  } else if (score >= 3) {
    level = 'weak';
  }

  return {
    score,
    level,
    valid: checks.minLength && checks.multipleCharsets,
    checks,
  };
};

type UserProfileModalProps = {
  show: boolean;
  onHide: () => void;
};

export const UserProfileModal = ({ show, onHide }: UserProfileModalProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t, i18n } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const [email, setEmail] = useState('');
  const [language, setLanguage] = useState('de');
  const [username, setUsername] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');

  const isEmailInputValid = isValidEmail(email);

  const passwordStrength = evaluatePasswordStrength(newPassword);
  const isPasswordInputValid =
    Boolean(currentPassword) &&
    Boolean(newPassword) &&
    Boolean(newPasswordConfirm) &&
    newPassword === newPasswordConfirm &&
    passwordStrength.valid;

  const passwordStrengthVariantByLevel: Record<
    PasswordStrength['level'],
    string
  > = {
    very_weak: 'danger',
    weak: 'danger',
    medium: 'warning',
    strong: 'info',
    very_strong: 'success',
  };

  const handleClose = () => {
    setCurrentPassword('');
    setNewPassword('');
    setNewPasswordConfirm('');
    onHide();
  };

  const loadProfile = () => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => {
        const data = (response?.data || {}) as UserProfileResponse;
        setUsername(data.username || '');
        setEmail(data.email || '');
        setLanguage(data.language || 'de');
        showInfoBar(enqueueSnackbar, t('profile_load_success'));
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `${t('profile_load_error')}: ${reason}`);
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    if (!show) {
      return;
    }

    loadProfile();
  }, [show]);

  const saveSettings = () => {
    if (!isEmailInputValid) {
      showErrorBar(enqueueSnackbar, t('profile_email_invalid'));
      return;
    }

    showInfoBar(enqueueSnackbar, t('profile_settings_saving_info'));
    setIsSavingSettings(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/settings/',
      {
        email,
        language,
      },
      async () => {
        await i18n.changeLanguage(language);
        showSuccessBar(enqueueSnackbar, t('profile_settings_saved'));
        setIsSavingSettings(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `${t('profile_settings_error')}: ${reason}`,
        );
        setIsSavingSettings(false);
      },
    );
  };

  const changePassword = () => {
    if (!currentPassword || !newPassword || !newPasswordConfirm) {
      showErrorBar(enqueueSnackbar, t('profile_password_missing'));
      return;
    }

    if (newPassword !== newPasswordConfirm) {
      showErrorBar(enqueueSnackbar, t('profile_password_mismatch'));
      return;
    }

    if (!passwordStrength.valid) {
      showErrorBar(enqueueSnackbar, t('profile_password_weak'));
      return;
    }

    showInfoBar(enqueueSnackbar, t('profile_password_saving_info'));
    setIsSavingPassword(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/password/change/',
      {
        current_password: currentPassword,
        new_password: newPassword,
      },
      () => {
        showSuccessBar(enqueueSnackbar, t('profile_password_saved'));
        setCurrentPassword('');
        setNewPassword('');
        setNewPasswordConfirm('');
        setIsSavingPassword(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `${t('profile_password_error')}: ${reason}`,
        );
        setIsSavingPassword(false);
      },
    );
  };

  if (loading) {
    return (
      <Modal
        show={show}
        onHide={handleClose}
        dialogClassName={'user-profile-modal'}
      >
        <Modal.Header closeButton>
          <Modal.Title>{t('profile_title')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="py-2 d-flex align-items-center gap-3">
            <Spinner animation="border" role="status" />
            <span>{t('profile_loading')}</span>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleClose}>
            {t('profile_close')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  return (
    <Form>
      <Modal
        show={show}
        onHide={handleClose}
        dialogClassName={'user-profile-modal'}
      >
        <Modal.Header closeButton>
          <Modal.Title>
            {t('profile_title')}: {username}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Row className="g-4">
            <Col xs={12} lg={6}>
              <Card className="border-0 shadow-sm h-100">
                <Card.Body className="p-4 m-2">
                  <h5 className="mb-3">{t('profile_settings')}</h5>

                  <Form.Group className="mb-3">
                    <Form.Label>{t('profile_email')}</Form.Label>
                    <Form.Control
                      type="email"
                      value={email}
                      isInvalid={Boolean(email) && !isEmailInputValid}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                    <Form.Control.Feedback type="invalid">
                      {t('profile_email_invalid')}
                    </Form.Control.Feedback>
                  </Form.Group>

                  <Form.Group className="mb-4">
                    <Form.Label>{t('profile_language')}</Form.Label>
                    <Form.Select
                      value={language}
                      onChange={(event) => setLanguage(event.target.value)}
                    >
                      <option value="de">Deutsch</option>
                      <option value="en">English</option>
                    </Form.Select>
                  </Form.Group>

                  <Button
                    onClick={saveSettings}
                    disabled={isSavingSettings || !isEmailInputValid}
                  >
                    {isSavingSettings
                      ? t('profile_saving')
                      : t('profile_save_settings')}
                  </Button>
                </Card.Body>
              </Card>
            </Col>

            <Col xs={12} lg={6}>
              <Card className="border-0 shadow-sm h-100">
                <Card.Body className="p-4 m-2">
                  <h5 className="mb-3">{t('profile_change_password')}</h5>

                  <Form.Group className="mb-3">
                    <Form.Label>{t('profile_current_password')}</Form.Label>
                    <Form.Control
                      type="password"
                      value={currentPassword}
                      onChange={(event) =>
                        setCurrentPassword(event.target.value)
                      }
                    />
                  </Form.Group>

                  <Form.Group className="mb-3">
                    <Form.Label>{t('profile_new_password')}</Form.Label>
                    <Form.Control
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                    />
                  </Form.Group>

                  <div className="mb-3">
                    <div className="d-flex justify-content-between align-items-center mb-1">
                      <small className="text-muted">
                        {t('profile_password_strength')}
                      </small>
                      <small>
                        {t(
                          `profile_password_strength_${passwordStrength.level}`,
                        )}
                      </small>
                    </div>
                    <ProgressBar
                      now={(passwordStrength.score / 6) * 100}
                      variant={
                        passwordStrengthVariantByLevel[passwordStrength.level]
                      }
                    />
                    <small className="text-muted d-block mt-2">
                      {t('profile_password_requirements_hint')}
                    </small>
                    <small className="d-block mt-1">
                      {passwordStrength.checks.minLength
                        ? t('profile_password_requirement_min_length_ok')
                        : t('profile_password_requirement_min_length')}
                    </small>
                    <small className="d-block">
                      {passwordStrength.checks.multipleCharsets
                        ? t('profile_password_requirement_charset_ok')
                        : t('profile_password_requirement_charset')}
                    </small>
                  </div>

                  <Form.Group className="mb-4">
                    <Form.Label>{t('profile_confirm_password')}</Form.Label>
                    <Form.Control
                      type="password"
                      value={newPasswordConfirm}
                      onChange={(event) =>
                        setNewPasswordConfirm(event.target.value)
                      }
                    />
                  </Form.Group>

                  <Button
                    onClick={changePassword}
                    disabled={isSavingPassword || !isPasswordInputValid}
                  >
                    {isSavingPassword
                      ? t('profile_saving')
                      : t('profile_save_password')}
                  </Button>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="secondary" onClick={handleClose}>
            {t('profile_close')}
          </Button>
        </Modal.Footer>
      </Modal>
    </Form>
  );
};

const UserProfile = () => {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(true);

  return (
    <Col>
      <UserProfileModal show={showModal} onHide={() => setShowModal(false)} />
      {!showModal && (
        <Card className="border-0 shadow-sm">
          <Card.Body className="p-4 m-2 d-flex justify-content-between align-items-center">
            <span>{t('profile_modal_reopen_hint')}</span>
            <Button onClick={() => setShowModal(true)}>
              {t('profile_settings_button')}
            </Button>
          </Card.Body>
        </Card>
      )}
    </Col>
  );
};

export default UserProfile;
