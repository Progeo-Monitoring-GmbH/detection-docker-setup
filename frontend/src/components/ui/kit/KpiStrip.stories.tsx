import type { Meta, StoryObj } from '@storybook/react';
import KpiStrip from './KpiStrip';

const meta: Meta<typeof KpiStrip> = {
  title: 'Kit/KpiStrip',
  component: KpiStrip,
};
export default meta;

type Story = StoryObj<typeof KpiStrip>;

export const Default: Story = {
  args: {
    tiles: [
      { label: 'Objektstatus', value: 'Kritisch', note: '2 offene Verdachtsstellen', valueColor: '#C44D26' },
      { label: 'Verdachtsstellen', value: '2', unit: 'aktiv' },
      { label: 'Höchster Messwert', value: '366', unit: 'mV' },
      { label: 'Anlage', value: 'Online', valueColor: '#3F7A1C' },
    ],
  },
};
