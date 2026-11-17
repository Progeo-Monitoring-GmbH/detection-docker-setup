import { useTranslation } from 'react-i18next';
import { repeatedTestId } from '../testIds';

/** An account a user is a member of (Account.users) - /api/auth-support/staff/users/. */
export type UserAccount = { id: number; name: string };

export type AccountLegendEntry = UserAccount & {
  color: string;
  /** Members among the listed users. */
  count: number;
};

/**
 * Distinct hues for the account boxes, in the order they are handed out
 * (accounts sorted by name). Beyond the pool they repeat - the name is the
 * box's tooltip and the legend's text.
 */
export const ACCOUNT_COLORS = [
  '#2a78d6',
  '#eda100',
  '#1a9bb5',
  '#4a3aa7',
  '#e87ba4',
  '#3f7a1c',
  '#c44d26',
  '#8d6e63',
  '#0b3659',
  '#b07cc6',
  '#6d8a96',
  '#c9a227',
];

/** Filter value for users without any account. */
export const NO_ACCOUNT = 'none';

/**
 * Every account of `users` with its colour and member count, sorted by name
 * - the colour follows that order, so a box and its legend entry always
 * match.
 */
export const accountLegend = (users: { accounts?: UserAccount[] }[]): AccountLegendEntry[] => {
  const byId = new Map<number, UserAccount & { count: number }>();
  for (const user of users) {
    for (const account of user.accounts ?? []) {
      const entry = byId.get(account.id) ?? { ...account, count: 0 };
      entry.count += 1;
      byId.set(account.id, entry);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id - b.id)
    .map((entry, index) => ({ ...entry, color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length] }));
};

/** Does `user` match the account filter ('' = all, NO_ACCOUNT, or an account id)? */
export const matchesAccountFilter = (user: { accounts?: UserAccount[] }, filter: string) => {
  if (!filter) {
    return true;
  }
  const accounts = user.accounts ?? [];
  return filter === NO_ACCOUNT ? accounts.length === 0 : accounts.some((account) => String(account.id) === filter);
};

/** How many boxes a row shows before "+N". */
const MAX_BOXES = 8;

/** A row's accounts: one coloured box each (the name as tooltip). */
export const AccountBoxes = ({
  userId,
  accounts,
  colorOf,
}: {
  userId: number;
  accounts: UserAccount[];
  colorOf: (id: number) => string;
}) => {
  const { t } = useTranslation();
  if (accounts.length === 0) {
    return (
      <span className="staff-account-none" {...repeatedTestId('staff-user-accounts', userId)}>
        {t('staff_accounts_none')}
      </span>
    );
  }
  const shown = accounts.slice(0, MAX_BOXES);
  const names = accounts.map((account) => account.name).join(', ');
  return (
    <span className="staff-account-boxes" title={names} {...repeatedTestId('staff-user-accounts', userId)}>
      {shown.map((account) => (
        <span
          key={account.id}
          role="img"
          aria-label={account.name}
          title={account.name}
          className="staff-account-box"
          style={{ backgroundColor: colorOf(account.id) }}
          data-account={account.id}
        />
      ))}
      {accounts.length > MAX_BOXES && <span className="staff-account-more">+{accounts.length - MAX_BOXES}</span>}
    </span>
  );
};

/** The colour legend above the table - a click filters the list by that account. */
export const AccountLegend = ({
  entries,
  withoutAccount,
  selected,
  onSelect,
}: {
  entries: AccountLegendEntry[];
  /** Users without any account. */
  withoutAccount: number;
  /** The account filter ('' = all). */
  selected: string;
  onSelect: (value: string) => void;
}) => {
  const { t } = useTranslation();
  if (entries.length === 0 && withoutAccount === 0) {
    return null;
  }
  const toggle = (value: string) => onSelect(selected === value ? '' : value);
  return (
    <div className="staff-account-legend" data-testid="staff-account-legend">
      <span className="staff-account-legend-title">{t('staff_accounts_legend')}</span>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`staff-account-legend-entry${selected === String(entry.id) ? ' staff-account-legend-entry--active' : ''}`}
          aria-pressed={selected === String(entry.id)}
          title={t('staff_accounts_legend_filter')}
          onClick={() => toggle(String(entry.id))}
          {...repeatedTestId('staff-account-legend-entry', entry.id)}
        >
          <span aria-hidden="true" className="staff-account-box" style={{ backgroundColor: entry.color }} />
          {entry.name}
          <span className="staff-account-legend-count">{entry.count}</span>
        </button>
      ))}
      {withoutAccount > 0 && (
        <button
          type="button"
          className={`staff-account-legend-entry${selected === NO_ACCOUNT ? ' staff-account-legend-entry--active' : ''}`}
          aria-pressed={selected === NO_ACCOUNT}
          title={t('staff_accounts_legend_filter')}
          onClick={() => toggle(NO_ACCOUNT)}
          {...repeatedTestId('staff-account-legend-entry', NO_ACCOUNT)}
        >
          <span aria-hidden="true" className="staff-account-box staff-account-box--empty" />
          {t('staff_accounts_none')}
          <span className="staff-account-legend-count">{withoutAccount}</span>
        </button>
      )}
    </div>
  );
};
