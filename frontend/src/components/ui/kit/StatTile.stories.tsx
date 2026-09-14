import type { Meta, StoryObj } from '@storybook/react';
import StatTile from './StatTile';

const meta: Meta<typeof StatTile> = {
  title: 'Kit/StatTile',
  component: StatTile,
};
export default meta;

type Story = StoryObj<typeof StatTile>;

export const Default: Story = {
  args: {
    label: 'Objektstatus',
    value: 'Kritisch',
    note: '2 offene Verdachtsstellen',
    valueColor: '#C44D26',
  },
};

export const NoAnomalies: Story = {
  args: {
    label: 'Objektstatus',
    value: 'OK',
    note: 'keine Auffälligkeit',
    valueColor: '#3F7A1C',
  },
};

export const WithUnit: Story = {
  args: {
    label: 'Höchster Messwert',
    value: '321',
    unit: 'mV',
    note: 'Verdachtsstelle 2',
  },
};
