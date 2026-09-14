import type { Meta, StoryObj } from '@storybook/react';
import SeverityBadge from './SeverityBadge';

const meta: Meta<typeof SeverityBadge> = {
  title: 'Kit/SeverityBadge',
  component: SeverityBadge,
};
export default meta;

type Story = StoryObj<typeof SeverityBadge>;

export const Beobachten: Story = { args: { severity: 'beobachten', label: 'Beobachten' } };
export const Alarm: Story = { args: { severity: 'alarm', label: 'Alarm' } };
export const Kritisch: Story = { args: { severity: 'kritisch', label: 'Kritisch' } };

export const AllSeverities: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <SeverityBadge severity="beobachten" label="Beobachten" />
      <SeverityBadge severity="alarm" label="Alarm" />
      <SeverityBadge severity="kritisch" label="Kritisch" />
    </div>
  ),
};
