"""Phone numbers in E.164 (`+4917112345678`).

The portal's phone fields (frontend PhoneInput, frontend/src/components/ui/
phone.ts - keep the rules in step) send E.164; these helpers check and
normalise what reaches the backend, from the portal or other clients:
"+49 171 …", "0049 …" and national numbers ("0171 …", the default calling
code, trunk 0 dropped) all become E.164.

Stored values from before (free text) stay valid until they are changed:
`clean_phone(new, stored)` keeps an unchanged legacy value instead of
refusing the whole form because of it.
"""
import re

DEFAULT_DIAL = "49"
# Italy keeps the leading 0 of its national numbers.
_KEEPS_LEADING_ZERO = {"39"}
_E164 = re.compile(r"^\+[1-9]\d{6,14}$")


class InvalidPhoneNumber(ValueError):
    """Not a plausible phone number (7 to 15 digits with the calling code)."""


def is_e164(value) -> bool:
    return bool(_E164.match(str(value or "").strip()))


def to_e164(raw, default_dial: str = DEFAULT_DIAL) -> str | None:
    """`raw` as E.164, None when empty. Raises InvalidPhoneNumber."""
    text = str(raw or "").strip()
    if not text:
        return None
    digits = "".join(char for char in text if char.isdigit())
    if not digits:
        raise InvalidPhoneNumber(text)
    if text.startswith("+"):
        number = f"+{digits}"
    elif digits.startswith("00"):
        number = f"+{digits[2:]}"
    else:
        national = digits if default_dial in _KEEPS_LEADING_ZERO else digits.lstrip("0")
        number = f"+{default_dial}{national}"
    if not _E164.match(number):
        raise InvalidPhoneNumber(text)
    return number


def clean_phone(raw, stored=None, default_dial: str = DEFAULT_DIAL) -> str | None:
    """A phone field on save: E.164, None when empty. An unchanged stored
    value that isn't E.164 (entered before the normalisation) is kept as it
    is. Raises InvalidPhoneNumber for a new implausible value."""
    text = str(raw or "").strip()
    if not text:
        return None
    if stored is not None and text == str(stored).strip():
        try:
            return to_e164(text, default_dial)
        except InvalidPhoneNumber:
            return text
    return to_e164(text, default_dial)
