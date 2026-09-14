import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import SegmentedControl from './SegmentedControl';

const meta: Meta<typeof SegmentedControl> = {
  title: 'Kit/SegmentedControl',
  component: SegmentedControl,
};
export default meta;

type Story = StoryObj<typeof SegmentedControl>;

export const Default: Story = {
  args: {
    options: [
      { value: 'blob', label: 'Verlauf' },
      { value: 'points', label: 'Messpunkte' },
    ],
    value: 'blob',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return <SegmentedControl {...args} value={value} onChange={setValue} />;
  },
};
