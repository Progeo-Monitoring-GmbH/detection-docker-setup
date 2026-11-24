/**
 * The anchors (#...) of the Lageplan wizard's steps - links such as the
 * checklist's "Beheben" open the wizard at the step that fixes the point
 * (LageplanWizardView scrolls there once the location is loaded).
 */
export const WIZARD_ANCHORS = {
  location: 'wizard-location',
  devices: 'wizard-devices',
  plans: 'wizard-plans',
  points: 'wizard-points',
  align: 'wizard-align',
  autoRepair: 'wizard-auto-repair',
  dmTransfer: 'wizard-dm-transfer',
  heatLimits: 'wizard-heat-limits',
  klemmliste: 'wizard-klemmliste',
} as const;

export type WizardStep = keyof typeof WIZARD_ANCHORS;

/** The wizard for location `id`, opened at `step`. */
export const wizardPath = (id: number, step?: WizardStep) =>
  `/site-plan/wizard/?location=${id}${step ? `#${WIZARD_ANCHORS[step]}` : ''}`;
