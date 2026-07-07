import React, { useEffect } from 'react';
import { Button, Card, Col, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions, {
  getSinglePermissionForwardUrl,
} from '../../hooks/usePermissions';
import LoadingIcon from '../components/ui/LoadingIcon';

type LandingModule = {
  permission: string;
  labelKey: string;
  target: string;
};

const LANDING_MODULES: LandingModule[] = [
  {
    permission: 'module_devices_enabled',
    labelKey: 'landing_module_devices',
    target: '/device/overview/',
  },
  {
    permission: 'module_locations_enabled',
    labelKey: 'landing_module_locations',
    target: '/location/overview/',
  },
  {
    permission: 'module_measurements_enabled',
    labelKey: 'landing_module_measurements',
    target: '/device/measure/',
  },
  {
    permission: 'module_imei_enabled',
    labelKey: 'landing_module_imei',
    target: '/devices/imei/display/',
  },
  {
    permission: 'module_backup_enabled',
    labelKey: 'landing_module_backup',
    target: '/backup/1/overview/',
  },
  {
    permission: 'module_docker_enabled',
    labelKey: 'landing_module_docker',
    target: '/docker/',
  },
  {
    permission: 'module_admin_enabled',
    labelKey: 'landing_module_admin',
    target: '/admin/panel/',
  },
];

const LandingPage = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { hasPermission, isLoading, permissions } = usePermissions();

  const availableModules = React.useMemo(
    () => LANDING_MODULES.filter((module) => hasPermission(module.permission)),
    [hasPermission],
  );

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const forwardUrl = getSinglePermissionForwardUrl(permissions);

    if (forwardUrl) {
      auth.navigate(forwardUrl);
    }
  }, [auth, isLoading, permissions]);

  if (isLoading) {
    return (
      <Row>
        <LoadingIcon />
      </Row>
    );
  }

  if (availableModules.length === 0) {
    return (
      <Row className="mt-3">
        <Col>
          <Card>
            <Card.Body>
              <Card.Title>{t('landing_no_modules_title')}</Card.Title>
              <Card.Text>{t('landing_no_modules_description')}</Card.Text>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    );
  }

  if (availableModules.length > 1) {
    return (
      <Row className="mt-3 g-3">
        <Col xs={12}>
          <Card>
            <Card.Body>
              <Card.Title>{t('landing_select_title')}</Card.Title>
              <Card.Text>{t('landing_select_description')}</Card.Text>
              {availableModules.map((module) => (
                <Button
                  key={module.permission}
                  className="me-2 mb-2"
                  onClick={() => auth.navigate(module.target)}
                >
                  {t(module.labelKey)}
                </Button>
              ))}
            </Card.Body>
          </Card>
        </Col>
      </Row>
    );
  }

  return (
    <Row>
      <LoadingIcon />
    </Row>
  );
};

export default LandingPage;
