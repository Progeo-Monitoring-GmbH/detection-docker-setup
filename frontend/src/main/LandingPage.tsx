import { useEffect } from 'react';
import { Button, Card, Col, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions, {
  getSinglePermissionForwardUrl,
} from '../../hooks/usePermissions';
import LoadingIcon from '../components/ui/LoadingIcon';
import { routeRule, useAccess, type AppRoutePath } from './access';
import { repeatedTestId } from '../testIds';

type LandingModule = {
  /** Its route in APP_ROUTE_ACCESS - offered only where that lets the user in. */
  route: AppRoutePath;
  labelKey: string;
  target: string;
};

const LANDING_MODULES: LandingModule[] = [
  {
    route: '/device/overview',
    labelKey: 'landing_module_devices',
    target: '/device/overview/',
  },
  {
    route: '/location/overview/',
    labelKey: 'landing_module_locations',
    target: '/location/overview/',
  },
  {
    route: '/alarms/',
    labelKey: 'landing_module_alarms',
    target: '/alarms/',
  },
  {
    route: '/backup/:account/overview/',
    labelKey: 'landing_module_backup',
    target: '/backup/1/overview/',
  },
  {
    route: '/developer',
    labelKey: 'landing_module_docker',
    target: '/developer/docker/',
  },
  {
    route: '/admin/panel/',
    labelKey: 'landing_module_admin',
    target: '/admin/panel/',
  },
];

const LandingPage = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { hasPermission, isLoading, permissions } = usePermissions();
  const { can } = useAccess();

  const availableModules = LANDING_MODULES.filter((module) =>
    can(routeRule(module.route)),
  );

  useEffect(() => {
    if (!auth.token || !auth.user) {
      const forward = auth.location || '/';
      auth.navigate(`/login?forward=${encodeURIComponent(forward)}`);
      return;
    }

    if (isLoading) {
      return;
    }

    // The locations overview is the portal's home; the module picker below is
    // only a fallback for accounts without the locations module.
    const forwardUrl = hasPermission('module_locations_enabled')
      ? '/location/overview/'
      : getSinglePermissionForwardUrl(permissions);

    if (forwardUrl) {
      auth.navigate(forwardUrl);
    }
  }, [auth, isLoading, permissions, hasPermission]);

  if (!auth.token || !auth.user) {
    return (
      <Row data-testid="page-landing">
        <LoadingIcon />
      </Row>
    );
  }

  if (isLoading) {
    return (
      <Row data-testid="page-landing">
        <LoadingIcon />
      </Row>
    );
  }

  if (availableModules.length === 0) {
    return (
      <Row className="mt-3" data-testid="page-landing">
        <Col>
          <Card data-testid="landing-no-modules">
            <Card.Body>
              <Card.Title>{t('landing_no_modules_title')}</Card.Title>
              <Card.Text>{t('landing_no_modules_description')}</Card.Text>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    );
  }

  if (availableModules.length > 1 && !hasPermission('module_locations_enabled')) {
    return (
      <Row className="mt-3 g-3" data-testid="page-landing">
        <Col xs={12}>
          <Card data-testid="landing-module-picker">
            <Card.Body>
              <Card.Title>{t('landing_select_title')}</Card.Title>
              <Card.Text>{t('landing_select_description')}</Card.Text>
              {availableModules.map((module) => (
                <Button
                  key={module.route}
                  className="me-2 mb-2"
                  onClick={() => auth.navigate(module.target)}
                  {...repeatedTestId('landing-module', module.route)}
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
    <Row data-testid="page-landing">
      <LoadingIcon />
    </Row>
  );
};

export default LandingPage;
