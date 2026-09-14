import type { Meta, StoryObj } from '@storybook/react';
import PillButton from './PillButton';

const meta: Meta<typeof PillButton> = {
  title: 'Kit/PillButton',
  component: PillButton,
  args: { onClick: () => {} },
};
export default meta;

type Story = StoryObj<typeof PillButton>;

export const Default: Story = {
  args: { label: 'Nutzer' },
};

export const Active: Story = {
  args: { label: 'Nutzer', active: true },
};

export const Ghost: Story = {
  args: { label: 'Kundenadmin', variant: 'ghost' },
};

export const Disabled: Story = {
  args: { label: 'ProGeo-Admin', disabled: true },
};
