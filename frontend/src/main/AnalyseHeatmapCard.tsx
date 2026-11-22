import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { Magic } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import {
  FullscreenButton,
  FullscreenFrame,
  useFullscreen,
} from '../components/ui/kit/Fullscreen';
import PanelCard from '../components/ui/kit/PanelCard';
import PlotHelp from '../components/ui/PlotHelp';
import type {
  HeatProfile,
  SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';

type AnalyseHeatmapCardProps = {
  locationId: number;
  planId: number | null;
  isStaff: boolean;
  state: ReturnType<typeof useFullscreen>;
  heatmapLoading: boolean;
  heatmapOpen: boolean;
  onToggleOpen: () => void;
  compare: boolean;
  compareLabel: string;
  shownHeatmap: SensorHeatmapResponse | null;
  changeHeatmap: SensorHeatmapResponse | null;
  switchingPlan: boolean;
  planSwitcher: ReactNode;
  selectedPositions: number[];
  focusedPosition: number | null;
  onAreaSelect: (positions: number[]) => void;
  onSensorClick: (position: number) => void;
  time: number | null;
  onTimeChange: (time: number | null) => void;
  profile: HeatProfile;
  onProfileChange: (profile: HeatProfile) => void;
  onPlanChange: (id: number) => void;
};

const AnalyseHeatmapCard = ({
  locationId,
  planId,
  isStaff,
  state,
  heatmapLoading,
  heatmapOpen,
  onToggleOpen,
  compare,
  compareLabel,
  shownHeatmap,
  changeHeatmap,
  switchingPlan,
  planSwitcher,
  selectedPositions,
  focusedPosition,
  onAreaSelect,
  onSensorClick,
  time,
  onTimeChange,
  profile,
  onProfileChange,
  onPlanChange,
}: AnalyseHeatmapCardProps) => {
  const { t } = useTranslation();

  return (
    <FullscreenFrame state={state}>
      <PanelCard
        testId="analyse-heatmap"
        foldable
        open={heatmapOpen}
        onToggle={onToggleOpen}
        title={t('analyse_heatmap_title')}
        actions={
          <div className="d-flex align-items-center gap-2 flex-wrap">
            {compare && (
              <span
                className="small text-muted"
                data-testid="analyse-heatmap-change"
              >
                {t('analyse_heatmap_change', { label: compareLabel })}
              </span>
            )}
            {heatmapLoading && (
              <Spinner
                size="sm"
                animation="border"
                className="text-muted"
                data-testid="analyse-heatmap-loading"
              />
            )}
            {isStaff && (
              <Link
                to={`/site-plan/wizard/?location=${locationId}${planId != null ? `&plan=${planId}` : ''}`}
                className="analyse-wizard-link"
                title={t('analyse_open_wizard_hint')}
                data-testid="analyse-open-wizard"
              >
                <Magic className="analyse-wizard-link-icon" aria-hidden />
                <span>{t('analyse_open_wizard')}</span>
              </Link>
            )}
            {heatmapOpen && (
              <FullscreenButton
                state={state}
                testId="analyse-heatmap-fullscreen"
              />
            )}
            <PlotHelp topic="heatmap" testId="analyse-heatmap-help" />
          </div>
        }
      >
        {heatmapLoading && !shownHeatmap ? (
          <>
            {planSwitcher && (
              <div className="d-flex px-2 pt-2">{planSwitcher}</div>
            )}
            <div
              className="d-flex justify-content-center align-items-center py-5 text-muted"
              data-testid="analyse-heatmap-plan-loading"
            >
              <Spinner animation="border" className="me-2" /> {t('ui_loading')}
            </div>
          </>
        ) : (
          <SensorHeatmap2D
            response={changeHeatmap ?? shownHeatmap}
            heatTitle={changeHeatmap ? t('heatmap_change') : undefined}
            forceNormalize={changeHeatmap != null}
            onAreaSelect={onAreaSelect}
            selectedPositions={selectedPositions}
            focusedPosition={focusedPosition}
            fitPlan
            hideChrome
            time={time}
            onTimeChange={onTimeChange}
            hideFrameSlider
            onSensorClick={onSensorClick}
            profile={profile}
            onProfileChange={onProfileChange}
            profileLoading={heatmapLoading}
            planId={switchingPlan ? (shownHeatmap?.lageplan ?? null) : planId}
            onPlanChange={onPlanChange}
            busy={switchingPlan}
            toolbarStart={planSwitcher}
          />
        )}
      </PanelCard>
    </FullscreenFrame>
  );
};

export default AnalyseHeatmapCard;
