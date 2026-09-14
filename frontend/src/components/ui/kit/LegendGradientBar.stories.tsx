import type { Meta, StoryObj } from '@storybook/react';
import LegendGradientBar from './LegendGradientBar';

const meta: Meta<typeof LegendGradientBar> = {
  title: 'Kit/LegendGradientBar',
  component: LegendGradientBar,
};
export default meta;

type Story = StoryObj<typeof LegendGradientBar>;

export const Default: Story = {
  args: {
    title: 'Wirkpotenzial',
    stops: ['#0B3659', '#61AAC5', '#FBBC15', '#EB633B'],
    ticks: ['0 mV', '200 mV', '400 mV'],
  },
};
