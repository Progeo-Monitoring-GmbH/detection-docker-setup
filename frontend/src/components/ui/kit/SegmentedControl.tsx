import PillButton from './PillButton';

type SegmentedOption = { value: string; label: string };

type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Block switching while a request is running (e.g. a heavy stats scan). */
  disabled?: boolean;
};

/** The pill-track filter/toggle group (view switchers, sequence controls, ...). */
const SegmentedControl = ({
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedControlProps) => {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 3,
        background: 'var(--progeo-track)',
        borderRadius: 'var(--progeo-radius-pill)',
        padding: 3,
      }}
    >
      {options.map((option) => (
        <PillButton
          key={option.value}
          label={option.label}
          active={option.value === value}
          onClick={() => onChange(option.value)}
          disabled={disabled}
        />
      ))}
    </div>
  );
};

export default SegmentedControl;
