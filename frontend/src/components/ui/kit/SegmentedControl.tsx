import PillButton from './PillButton';

export type SegmentedOption = { value: string; label: string };

type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
};

/** The pill-track filter/toggle group (view switchers, sequence controls, ...). */
const SegmentedControl = ({ options, value, onChange }: SegmentedControlProps) => {
  return (
    <div
      style={{
        display: 'flex',
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
        />
      ))}
    </div>
  );
};

export default SegmentedControl;
