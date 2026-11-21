import { Funnel } from 'react-bootstrap-icons';
import type { NoiseBadge } from './analyseNoiseView';
import './LocationAnalyseTab.css';

const scrollToNoisePanel = () =>
  document
    .querySelector('[data-testid="noise-profile-panel"]')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/**
 * Staff: which Störungsprofil the shown values are cleaned with
 * (noiseBadgeOf) - right in the frame picker; a click scrolls to the
 * profile panel. Its colours depend on the profile's state (inline).
 */
const AnalyseNoiseBadge = ({ badge }: { badge: NoiseBadge }) => (
  <button
    type="button"
    className="btn btn-sm d-inline-flex align-items-center gap-1 py-0 fw-semibold text-truncate analyse-noise-badge"
    style={{
      color: badge.color,
      background: badge.background,
      border: `1px solid ${badge.color}`,
    }}
    title={badge.hint}
    data-testid="noise-profile-badge"
    onClick={scrollToNoisePanel}
  >
    <Funnel size={11} aria-hidden="true" />
    <span className="text-truncate">{badge.text}</span>
  </button>
);

export default AnalyseNoiseBadge;
