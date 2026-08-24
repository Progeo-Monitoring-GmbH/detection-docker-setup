"""
Backwards-compatible shim: email logic moved to `progeo.helper.emailhelper`.

Importing from `progeo.helper.emails` still works; new code should use
`progeo.helper.emailhelper` directly.
"""

from progeo.helper.emailhelper import (  # noqa: F401
    _send_mail,
    render_email_template,
    send_alarm_email,
    send_info_mail,
    send_mail,
    send_template_mail,
    smtp_configured,
)
