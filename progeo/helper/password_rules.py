"""What a password set in the portal has to be - the profile (change / set
password) and "Add user" on /staff/ ask the same, like the frontend's
PasswordStrengthMeter (components/ui/PasswordStrengthMeter.tsx):

- at least 8 characters with at least three of: lower case, upper case,
  digits, special characters (is_minimally_strong), and
- Django's AUTH_PASSWORD_VALIDATORS (similar to the user, common, numeric).
"""
import secrets
import string

MIN_LENGTH = 8
WEAK_REASON = (
    "Password must be at least 8 characters long and include at least three character sets "
    "(lowercase, uppercase, digits, special characters)"
)
_SPECIAL = "!@#$%^&*()-_=+"


def is_minimally_strong(password) -> bool:
    if not password or len(password) < MIN_LENGTH:
        return False
    charsets = [
        any(char.islower() for char in password),
        any(char.isupper() for char in password),
        any(char.isdigit() for char in password),
        any(not char.isalnum() for char in password),
    ]
    return sum(charsets) >= 3


def generate_password(length=16) -> str:
    """A random password that passes is_minimally_strong - one of each kind for sure."""
    kinds = [string.ascii_lowercase, string.ascii_uppercase, string.digits, _SPECIAL]
    chars = [secrets.choice(kind) for kind in kinds]
    alphabet = "".join(kinds)
    chars += [secrets.choice(alphabet) for _ in range(length - len(chars))]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)
