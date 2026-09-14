type LegendGradientBarProps = {
  stops: string[];
  ticks: string[];
  title?: string;
};

/** The "Wirkpotenzial" gradient legend bar with tick labels underneath. */
const LegendGradientBar = ({ stops, ticks, title }: LegendGradientBarProps) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      {title && (
        <span
          style={{
            fontSize: 10.5,
            letterSpacing: '.11em',
            textTransform: 'uppercase',
            color: '#8B8383',
            fontWeight: 500,
          }}
        >
          {title}
        </span>
      )}
      <div
        style={{
          flex: 1,
          minWidth: 140,
          height: 8,
          borderRadius: 'var(--progeo-radius-pill)',
          background: `linear-gradient(90deg, ${stops.join(', ')})`,
        }}
      />
      <div style={{ display: 'flex', gap: 16, fontSize: 11.5, color: '#8B8383', fontWeight: 400 }}>
        {ticks.map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
    </div>
  );
};

export default LegendGradientBar;
