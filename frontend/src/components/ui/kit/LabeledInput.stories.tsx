import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import LabeledInput from './LabeledInput';

const meta: Meta<typeof LabeledInput> = {
  title: 'Kit/LabeledInput',
  component: LabeledInput,
};
export default meta;

type Story = StoryObj<typeof LabeledInput>;

export const Editable: Story = {
  args: { label: 'Projekt-Name', value: 'Kita Leingarten' },
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return <LabeledInput {...args} value={value} onChange={setValue} />;
  },
};

export const ReadOnly: Story = {
  args: { label: 'Projekt-Nr.', value: '5927', readOnly: true },
};
