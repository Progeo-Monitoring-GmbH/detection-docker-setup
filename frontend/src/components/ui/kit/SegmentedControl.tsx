import PillButton from './PillButton';
import './kit.css';
import { KeyChip } from '../KeyHints';
import { childTestId } from '../../../testIds';

type SegmentedOption = {
  value: string;
  label: string;
  /** The key that picks the option (handled by the page) - shown as a chip. */
  hotkey?: string;
  /** Hover text, e.g. how the key works. */
  title?: string;
};

type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Block switching while a request is running (e.g. a heavy stats scan). */
  disabled?: boolean;
  /** data-testid of the track; each option is "<testId>-option" with its value as data-test-key. */
  testId?: string;
};

/** The pill-track filter/toggle group (view switchers, sequence controls, ...). */
const SegmentedControl = ({
  options,
  value,
  onChange,
  disabled = false,
  testId,
}: SegmentedControlProps) => {
  return (
    <div className="progeo-pill-track" data-testid={testId}>
      {options.map((option) => (
        <PillButton
          key={option.value}
          label={option.label}
          icon={option.hotkey ? <KeyChip>{option.hotkey}</KeyChip> : undefined}
          title={option.title}
          active={option.value === value}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          testId={childTestId(testId, 'option')}
          testKey={testId ? option.value : undefined}
        />
      ))}
    </div>
  );
};

export default SegmentedControl;
