import { useState } from 'react';
import { Form } from 'react-bootstrap';
import { Building } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { childTestId, repeatedTestId } from '../testIds';

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
export const accountLegend = (
  users: { accounts?: UserAccount[] }[],
): AccountLegendEntry[] => {
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
    .map((entry, index) => ({
      ...entry,
      color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
    }));
};

/** Does `user` match the account filter ('' = all, NO_ACCOUNT, or an account id)? */
export const matchesAccountFilter = (
  user: { accounts?: UserAccount[] },
  filter: string,
) => {
  if (!filter) {
    return true;
  }
  const accounts = user.accounts ?? [];
  return filter === NO_ACCOUNT
    ? accounts.length === 0
    : accounts.some((account) => String(account.id) === filter);
};

/** How many boxes a row shows before "+N". */
const MAX_BOXES = 8;

/** The objects a user reaches by single access beyond their accounts - a building and the number. */
const SingleAccessCount = ({
  userId,
  count,
}: {
  userId: number;
  count: number;
}) => {
  const { t } = useTranslation();
  const title = t('staff_single_access', { count });
  return (
    <span
      className="staff-single-access"
      role="img"
      aria-label={title}
      title={title}
      {...repeatedTestId('staff-user-single-access', userId)}
    >
      <Building aria-hidden="true" size={12} />
      {count}
    </span>
  );
};

/**
 * A row's access: one coloured box per account - full access to all its
 * objects (the hint says so) - and the number of objects reached by single
 * access beyond them (single_access: ProgeoAccess rules outside the accounts).
 */
export const AccountBoxes = ({
  userId,
  accounts,
  singleAccess = 0,
  colorOf,
}: {
  userId: number;
  accounts: UserAccount[];
  singleAccess?: number;
  colorOf: (id: number) => string;
}) => {
  const { t } = useTranslation();
  const fullAccess = (account: UserAccount) =>
    t('staff_accounts_full_access', { name: account.name });
  if (accounts.length === 0) {
    return (
      <span
        className="staff-account-boxes"
        {...repeatedTestId('staff-user-accounts', userId)}
      >
        {singleAccess > 0 ? (
          <SingleAccessCount userId={userId} count={singleAccess} />
        ) : (
          <span className="staff-account-none">{t('staff_accounts_none')}</span>
        )}
      </span>
    );
  }
  const shown = accounts.slice(0, MAX_BOXES);
  return (
    <span
      className="staff-account-boxes"
      {...repeatedTestId('staff-user-accounts', userId)}
    >
      {shown.map((account) => (
        <span
          key={account.id}
          role="img"
          aria-label={fullAccess(account)}
          title={fullAccess(account)}
          className="staff-account-box"
          style={{ backgroundColor: colorOf(account.id) }}
          data-account={account.id}
        />
      ))}
      {accounts.length > MAX_BOXES && (
        <span
          className="staff-account-more"
          title={accounts.slice(MAX_BOXES).map(fullAccess).join('\n')}
        >
          +{accounts.length - MAX_BOXES}
        </span>
      )}
      {singleAccess > 0 && (
        <SingleAccessCount userId={userId} count={singleAccess} />
      )}
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
      <span className="staff-account-legend-title">
        {t('staff_accounts_legend')}
      </span>
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
          <span
            aria-hidden="true"
            className="staff-account-box"
            style={{ backgroundColor: entry.color }}
          />
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
          <span
            aria-hidden="true"
            className="staff-account-box staff-account-box--empty"
          />
          {t('staff_accounts_none')}
          <span className="staff-account-legend-count">{withoutAccount}</span>
        </button>
      )}
    </div>
  );
};

/** From this many accounts on, the picker gets a search field. */
const PICKER_SEARCH_FROM = 8;

/**
 * The accounts of a user in the user dialog: a checkbox for each account the
 * editor may hand out (account_choices of the users list - staff every
 * account, a customer admin their own), a search field once there are many.
 * `locked` (the reason): only the names - a customer admin can't change the
 * accounts of another customer admin (helper/account_members.py).
 */
export const AccountPicker = ({
  choices,
  selected,
  onChange,
  locked,
  colorOf,
  testId,
}: {
  choices: UserAccount[];
  selected: number[];
  onChange: (accounts: number[]) => void;
  locked?: string | null;
  colorOf: (id: number) => string;
  testId: string;
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  if (locked) {
    const names = choices
      .filter((account) => selected.includes(account.id))
      .map((account) => account.name);
    return (
      <div className="staff-account-picker" data-testid={testId}>
        <div className="staff-account-picker-locked">
          <b>{names.length ? names.join(', ') : t('staff_accounts_none')}</b>
        </div>
        <small
          className="text-muted"
          data-testid={childTestId(testId, 'locked')}
        >
          {locked}
        </small>
      </div>
    );
  }
  const needle = search.trim().toLowerCase();
  const shown = choices.filter(
    (account) => !needle || (account.name || '').toLowerCase().includes(needle),
  );
  const toggle = (id: number) =>
    onChange(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  return (
    <div className="staff-account-picker" data-testid={testId}>
      {choices.length >= PICKER_SEARCH_FROM && (
        <Form.Control
          size="sm"
          className="staff-account-picker-search"
          placeholder={t('staff_accounts_search')}
          aria-label={t('staff_accounts_search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid={childTestId(testId, 'search')}
        />
      )}
      <div className="staff-account-picker-list">
        {shown.map((account) => (
          <Form.Check
            key={account.id}
            type="checkbox"
            id={`${testId}-account-${account.id}`}
            checked={selected.includes(account.id)}
            onChange={() => toggle(account.id)}
            label={
              <span className="d-inline-flex align-items-center gap-1">
                <span
                  aria-hidden="true"
                  className="staff-account-box"
                  style={{ backgroundColor: colorOf(account.id) }}
                />
                {account.name}
              </span>
            }
            {...repeatedTestId(`${testId}-account`, account.id)}
          />
        ))}
        {shown.length === 0 && (
          <small className="text-muted">{t('staff_accounts_no_match')}</small>
        )}
      </div>
    </div>
  );
};
