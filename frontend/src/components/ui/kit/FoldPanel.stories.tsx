import type { Meta, StoryObj } from '@storybook/react-vite';
import FoldPanel from './FoldPanel';

const meta: Meta<typeof FoldPanel> = {
  title: 'Kit/FoldPanel',
  component: FoldPanel,
};
export default meta;

type Story = StoryObj<typeof FoldPanel>;

export const Folded: Story = {
  args: {
    title: 'SMTP Server',
    hint: 'Used for alarm / report mails.',
    testId: 'story-fold',
    children: <div>Panel content goes here.</div>,
  },
};

export const Open: Story = {
  args: {
    title: 'Lageplan',
    actions: <span>2 plan(s)</span>,
    defaultOpen: true,
    testId: 'story-fold-open',
    children: <div>Panel content goes here.</div>,
  },
};
