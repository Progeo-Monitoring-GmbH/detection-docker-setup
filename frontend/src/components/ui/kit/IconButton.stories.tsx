import type { Meta, StoryObj } from '@storybook/react';
import IconButton from './IconButton';

const meta: Meta<typeof IconButton> = {
  title: 'Kit/IconButton',
  component: IconButton,
  args: { onClick: () => {} },
};
export default meta;

type Story = StoryObj<typeof IconButton>;

export const ZoomIn: Story = {
  args: {
    title: 'Vergrößern',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
};
