# Migration info mail (one-time campaign)

The users of the old platform get one info mail: "the portal has moved, set your password". The link opens `/konto/einrichten/<token>`. There the user chooses a password (plus their 2FA code, if they have 2FA) and is **signed in right away**.

The campaign is meant to run **once** and then be switched off.

Code: [progeo/helper/migration_invites.py](../progeo/helper/migration_invites.py), command [migration_invites](../progeo/management/commands/migration_invites.py), page [MigrationSetup.tsx](../frontend/src/main/MigrationSetup.tsx), templates `emails/migration_invite.html` (German) and `emails/en/migration_invite.html` (English, used for users whose profile language is English). Tests: [test_migration_invites.py](../progeo/tests/test_migration_invites.py).

## Runbook

1. **Import the users** (if not done yet): `python manage.py import_users users.csv`. Adding `--invite` queues the new users right away; step 2 is then only needed for users imported earlier.
2. **Queue:** `python manage.py migration_invites --queue --dry-run` lists who would be queued: active customers with an address and no password yet, not staff, not queued before. Then run it without `--dry-run`. `--emails list.txt` limits the queue to the given addresses (one per line).
3. **Test first:**
   - Set `MIGRATION_INVITES_ENABLED=1` in `django.env` and restart the backend and Celery.
   - On staging (`MAIL_TEST_MODE=1`), every mail goes to `MAIL_TEST_RECIPIENT`.
   - `python manage.py migration_invites --send-now 2` sends a small batch right away (the window and the hourly limit still apply). Open the link and set a password.
4. **Let it run:** the Celery task `send_migration_invites` (every 10 minutes) mails the queue:
   - at most `MIGRATION_INVITES_PER_HOUR` per hour (default 40), and never more than half of the free room in `MAIL_LIMIT_GLOBAL_HOUR`, so alarms still get through and the circuit breaker doesn't trip;
   - only between 09:00 and 22:00.

   At 40 per hour, 500 users take about one and a half sending days.
5. **Watch:** `python manage.py migration_invites --status` shows the counts: queued, sent, completed (password set), failed, skipped. The Django admin has *Migration invites* per user. Staff → Versand shows each mail and any bounces.
   - `--requeue-failed` puts failed mails (suppressed address, limit, SMTP) back into the queue once the cause is fixed.
6. **Close:** when nothing is queued any more (`--status` says so), set `MIGRATION_INVITES_ENABLED=0` and restart. The campaign can't send anything after that, not even through the command.
   - **Links stay valid** for `MIGRATION_INVITE_DAYS` (default 21) after their mail, so late readers can still set their password.
   - `python manage.py migration_invites --revoke` voids all unused links early.
   - Users whose link expired request a login link on the login page, or staff send them an invitation from the user admin.

## Safeguards

- **No staff accounts:** staff and superusers never get a link, because a mailbox must not be enough to set an administrator's password.
- **No re-invites:** users who already have a password are skipped. If one sets a password before their mail goes out, the invite is marked completed and no mail is sent.
- **Scanner-safe:** opening the page only checks the token, because mail scanners open every link. Saving the password redeems the token.
- **One-time token:** the link works once. Only its SHA-256 is stored (a `LoginLink` with purpose `migration`), and the token is created in the worker, so it never passes through the Celery broker. The mail log shows the link masked.
- **After setting the password:** all of the user's other unused links are void, failed login counts are cleared, and the invite is marked `completed`.
- **Statistics:** used migration links appear in Insights → Aktivität under "Chat und Anmeldelinks".

## Settings (`django.env`)

| Variable | Default | |
| --- | --- | --- |
| `MIGRATION_INVITES_ENABLED` | 0 | 1 only while the campaign sends |
| `MIGRATION_INVITE_DAYS` | 21 | validity of the set-password link |
| `MIGRATION_INVITES_PER_HOUR` | 40 | mails per hour (also capped by the global mail limit) |
