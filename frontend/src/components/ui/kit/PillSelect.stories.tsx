import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import PillSelect from './PillSelect';

const meta: Meta<typeof PillSelect> = {
  title: 'Kit/PillSelect',
  component: PillSelect,
};
export default meta;

type Story = StoryObj<typeof PillSelect>;

export const Default: Story = {
  args: {
    label: 'Schrittweite',
    options: [
      { value: '1800', label: '30 min' },
      { value: '3600', label: '1 h' },
      { value: '86400', label: '1 Tag' },
    ],
    value: '3600',
  },
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return <PillSelect {...args} value={value} onChange={setValue} />;
  },
};
