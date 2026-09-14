import type { Meta, StoryObj } from '@storybook/react';
import StateBadge from './StateBadge';

const meta: Meta<typeof StateBadge> = {
  title: 'Kit/StateBadge',
  component: StateBadge,
};
export default meta;

type Story = StoryObj<typeof StateBadge>;

export const Neu: Story = { args: { state: 'neu', label: 'NEU' } };
export const Quittiert: Story = { args: { state: 'quittiert', label: 'QUITTIERT' } };
export const Geloest: Story = { args: { state: 'geloest', label: 'GELÖST' } };

export const AllStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <StateBadge state="neu" label="NEU" />
      <StateBadge state="quittiert" label="QUITTIERT" />
      <StateBadge state="geloest" label="GELÖST" />
    </div>
  ),
};
