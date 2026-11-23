import { Button } from 'react-bootstrap';
import { PencilSquare, Trash } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useStatusAccess } from './useStatusAccess';

/**
 * Staff: the location in the Django admin - edit / delete. Two small icon
 * buttons in the portal header, next to the escalation (LocationPortalLayout);
 * the full text is their tooltip. Needs module_locations_django_edit /
 * _delete, never for the demo user.
 */
const LocationAdminActions = ({ locationId }: { locationId: number }) => {
  const { t } = useTranslation();
  const { canEditInDjango, canDeleteInDjango } = useStatusAccess(false);
  if (!canEditInDjango && !canDeleteInDjango) {
    return null;
  }
  return (
    <div className="portal-admin-actions" data-testid="location-portal-admin">
      {canEditInDjango && (
        <Button
          as="a"
          size="sm"
          variant="outline-primary"
          href={`/aadmin/progeo/progeolocation/${locationId}/change/`}
          title={t('status_edit_location_django')}
          aria-label={t('status_edit_location_django')}
          data-testid="location-portal-django-edit"
        >
          <PencilSquare aria-hidden />
        </Button>
      )}
      {canDeleteInDjango && (
        <Button
          as="a"
          size="sm"
          variant="outline-danger"
          href={`/aadmin/progeo/progeolocation/${locationId}/delete/`}
          title={t('status_delete_location_django')}
          aria-label={t('status_delete_location_django')}
          data-testid="location-portal-django-delete"
        >
          <Trash aria-hidden />
        </Button>
      )}
    </div>
  );
};

export default LocationAdminActions;
