import type { Meta, StoryObj } from '@storybook/react';
import PanelCard from './PanelCard';

const meta: Meta<typeof PanelCard> = {
  title: 'Kit/PanelCard',
  component: PanelCard,
};
export default meta;

type Story = StoryObj<typeof PanelCard>;

export const Default: Story = {
  args: {
    title: 'Dachansicht',
    children: <div style={{ color: '#8B8383', fontSize: 13 }}>Panel content goes here.</div>,
  },
};

export const WithActions: Story = {
  args: {
    title: 'Verdachtsstellen',
    actions: <span style={{ fontSize: 12.5, color: '#EB633B', fontWeight: 500 }}>Alle ansehen</span>,
    children: <div style={{ color: '#8B8383', fontSize: 13 }}>Panel content goes here.</div>,
  },
};

export const NoHeader: Story = {
  args: {
    children: <div style={{ color: '#8B8383', fontSize: 13 }}>Just a plain panel body.</div>,
  },
};
