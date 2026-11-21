import { useEffect, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../ui/Snackbar.jsx';
import type { PickableLocation } from './LocationPicker';

/**
 * The locations a LocationPicker offers (/v1/location/min/), loaded once
 * when the component mounts. `errorKey`: the message when that fails.
 * `setLocations` lets a page update a row it changed.
 */
const usePickableLocations = (errorKey: string) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [locations, setLocations] = useState<PickableLocation[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(true);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location/min/',
      (response) => {
        setLocations(Array.isArray(response?.data) ? response.data : []);
        setLocationsLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t(errorKey), error);
        setLocationsLoading(false);
      },
    );
    // Once per mount, like the pages did before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { locations, setLocations, locationsLoading };
};

export default usePickableLocations;
