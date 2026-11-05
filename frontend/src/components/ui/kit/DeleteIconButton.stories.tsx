import type { Meta, StoryObj } from '@storybook/react-vite';
import DeleteIconButton from './DeleteIconButton';

const meta: Meta<typeof DeleteIconButton> = {
  title: 'Kit/DeleteIconButton',
  component: DeleteIconButton,
  args: { label: 'Gerät löschen', onClick: () => {} },
};
export default meta;

type Story = StoryObj<typeof DeleteIconButton>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};

export const AsLink: Story = {
  args: { href: '#', target: '_blank', label: 'Im Django-Admin löschen' },
};
