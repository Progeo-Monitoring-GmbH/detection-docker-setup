import { useEffect, useState } from 'react';
import { Button } from 'react-bootstrap';
import { ArrowLeft, Grid3x3Gap } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig.tsx';
import { type HeatProfile, heatProfileQuery, type SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import { childTestId } from '../testIds';

/** Debounce for the measurement-count slider before refetching. */
const RELOAD_DEBOUNCE_MS = 900;

/**
 * Loads /v1/location/:id/heatmap/ for the 2D and 3D heatmap views, refetching
 * (debounced) whenever the measurement limit changes or `refresh` is called.
 */
export const useLocationHeatmap = (id: string | undefined, profile: HeatProfile = 'diff') => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<SensorHeatmapResponse | null>(null);
  const [limit, setLimit] = useState(10);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    if (!id) {
      return undefined;
    }
    setLoading(true);
    const timeoutId = window.setTimeout(() => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${id}/heatmap/?limit=${limit}${heatProfileQuery(profile)}`,
        (result) => {
          setResponse((result?.data || null) as SensorHeatmapResponse | null);
          setLoading(false);
        },
        (error) => {
          showRequestError(enqueueSnackbar, 'Could not load location heatmap', error);
          setResponse(null);
          setLoading(false);
        },
      );
    }, RELOAD_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
    // Not per token refresh (auth) - only when what is shown changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, limit, profile, reloadVersion]);

  const refresh = () => setReloadVersion((version) => version + 1);

  return { loading, response, limit, setLimit, refresh };
};

type HeatmapViewHeaderProps = {
  id: string | undefined;
  /** The sibling view to switch to ("heatplot" = 3D, "heatmap2d" = 2D). */
  switchTo: 'heatplot' | 'heatmap2d';
  loading: boolean;
  onRefresh: () => void;
  className?: string;
  /** data-testid of the bar; its buttons are "<testId>-back" / "-switch" / "-refresh". */
  testId?: string;
};

/** Back / switch-view / refresh button bar of the location heatmap views. */
export const HeatmapViewHeader = ({
  id,
  switchTo,
  loading,
  onRefresh,
  className = '',
  testId = 'heatmap-view-header',
}: HeatmapViewHeaderProps) => {
  const navigate = useNavigate();
  return (
    <div
      className={`d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 ${className}`}
      data-testid={testId}
    >
      <div className="d-flex gap-2">
        <Button
          variant="outline-secondary"
          onClick={() => navigate('/location/overview/')}
          data-testid={childTestId(testId, 'back')}
        >
          <ArrowLeft className="me-2" />
          Back to Locations
        </Button>
        <Button
          variant="outline-primary"
          onClick={() => navigate(`/location/${id}/${switchTo}`)}
          data-testid={childTestId(testId, 'switch')}
        >
          <Grid3x3Gap className="me-2" />
          {switchTo === 'heatplot' ? '3D Heatmap' : '2D Heatmap'}
        </Button>
      </div>

      <Button
        variant="outline-primary"
        onClick={onRefresh}
        disabled={loading}
        data-testid={childTestId(testId, 'refresh')}
      >
        Refresh
      </Button>
    </div>
  );
};
