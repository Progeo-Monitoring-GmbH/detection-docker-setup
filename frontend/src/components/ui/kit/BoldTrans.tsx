import { Trans, useTranslation } from 'react-i18next';

/** The tags a BoldTrans text may use - both render as <strong>. */
const BOLD = { strong: <strong />, b: <strong /> };

/**
 * A translated text with bold parts - for dialog messages (ConfirmDialog's
 * `message`): the values the user has to check (names, counts, dates, what
 * gets deleted) are wrapped in <strong>…</strong> in the i18n string, e.g.
 * 'Delete <strong>{{name}}</strong>?'. Trans escapes the values, so a name
 * with "<" stays text. In a dialog, .progeo-dialog-message strong styles them.
 */
const BoldTrans = ({
  i18nKey,
  values,
}: {
  i18nKey: string;
  values?: Record<string, unknown>;
}) => {
  // t/i18n of the hook: the same translation as the rest of the component.
  const { t, i18n } = useTranslation();
  return <Trans i18nKey={i18nKey} values={values} t={t} i18n={i18n} components={BOLD} />;
};

export default BoldTrans;
