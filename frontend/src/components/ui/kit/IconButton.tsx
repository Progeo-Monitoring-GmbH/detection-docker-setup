import type { ReactNode } from 'react';

type IconButtonProps = {
  icon: ReactNode;
  onClick: () => void;
  title?: string;
};

/** Small circular icon-only button (zoom controls, playback controls, ...). */
const IconButton = ({ icon, onClick, title }: IconButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        width: 31,
        height: 31,
        border: 'none',
        borderRadius: 9,
        background: 'var(--progeo-surface)',
        boxShadow: '0 3px 10px rgba(11, 54, 89, .16)',
        color: 'var(--progeo-blue)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {icon}
    </button>
  );
};

export default IconButton;
