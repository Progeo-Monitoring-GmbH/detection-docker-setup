import base64
import csv
import fnmatch
import hashlib
import json
import os
import re
import secrets
import string
import subprocess
from datetime import datetime, date, timedelta

from django.core.exceptions import FieldError
from django.core.serializers.json import DjangoJSONEncoder
from django.db.models import QuerySet
from django.utils import timezone

from progeo.helper.basics import dlog, elog, get_current_year
from django.db import transaction, models
from charset_normalizer import from_path

regex_has_mail = re.compile(r'(\S+@\S+\.\S+)')
regex_has_link = re.compile(
    r'((http|https)://)?[a-zA-Z0-9\.\/\?\:@\-_=#]+\.([a-zA-Z]){2,6}([a-zA-Z0-9\.\&\/\?\:@\-_=#])*')
regex_has_replacer = re.compile(r'(\[\S+\])')
regex_first_integer = re.compile(r'^(\-?[\d,.]*)')


def get_file_encoding(_file):
    results = from_path(_file)
    return results.best().encoding


def add_dicts(dict1, dict2):
    result = dict2.copy()
    for key, value in dict1.items():
        if key in result:
            if isinstance(value, dict):
                result[key] |= value
            elif isinstance(value, date):
                pass
            else:
                result[key] += value
        else:
            result[key] = value
    return result


def remove_white_chars(txt):
    if not txt:
        return None
    return re.sub(r'\s+', ' ', txt)


def as_date(date_string, correction=0, fmt="%Y-%m-%d %H:%M:%S"):
    if not date_string:
        return None
    try:
        return datetime.strptime(str(date_string)[:19], fmt)
    except ValueError as e:
        elog(e, tag="[ValueError]")
        return None


def datetime_from_filename(filename, fmt="%Y%m%d_%H%M%S"):
    name = filename.split('.')[0]
    dt = datetime.strptime(name, fmt)
    return timezone.make_aware(dt)


def as_timestamp(date_string, correction=0, fmt="%Y-%m-%d %H:%M:%S"):
    if not date_string:
        return None
    try:
        _date = datetime.strptime(str(date_string)[:19], fmt)
    except ValueError as e:
        elog(e, tag="[ValueError]")
        return None

    return (int(_date.timestamp()) + int(correction)) * 1000


def is_local_ip(ip: str) -> bool:
    """
    Returns True if the string looks like a local IPv4 address based on integer patterns.
    """
    try:
        parts = ip.split('.')
        if len(parts) != 4:
            return False
        nums = [int(p) for p in parts]
        if any(n < 0 or n > 255 for n in nums):
            return False

        # Check private/local ranges
        return (
            nums[0] == 10 or
            (nums[0] == 172 and 16 <= nums[1] <= 31) or
            (nums[0] == 192 and nums[1] == 168) or
            ip == "127.0.0.1"
        )
    except ValueError:
        return False


def get_frontend_url():
    proto = os.getenv('PROTOCOL', 'https')
    url = os.getenv('FRONTEND_URL')
    if not url:
        elog("CONFIG-ERROR! FRONTEND_URL is not set")
        return "NO-URL"

    if is_local_ip(url):
        port = os.getenv('FRONTEND_PORT')
        if not port:
            elog("CONFIG-ERROR! FRONTEND_PORT is not set")
        return f"{proto}://{url}:{port}"
    return f"{proto}://{url}"

def get_weekdays_until_today(start_date: date) -> list[str]:
    """
    Given a start date string in the format "YYYY-MM-DD",
    return a list of all dates from the start date up to
    (but not including) today's date.
    """
    # Get today's date
    today = datetime.today().date()

    # If start_date is already today or in the future, return an empty list
    if start_date >= today:
        return []

    # Build the list of dates
    dates = []
    current_date = start_date
    while current_date <= today:
        if current_date.weekday() < 5:  # 0–4 correspond to Monday–Friday
            dates.append(current_date.strftime("%Y-%m-%d"))
        current_date += timedelta(days=1)

    return dates


def parse_date(_date):
    if isinstance(_date, int):
        return datetime.fromtimestamp(_date / 1000)
    if isinstance(_date, str):
        if re.match(r'^\d{1,2}\.\d{1,2}\.\d{4}, \d{2}:\d{2}:\d{2}$', _date):
            return datetime.strptime(_date, '%d.%m.%Y, %H:%M:%S')
        elif re.match(r'^\d{1,2}/\d{1,2}/\d{4}, \d{2}:\d{2}:\d{2}$', _date):
            return datetime.strptime(_date, '%d/%m/%Y, %H:%M:%S')
        elif re.match(r'^\d{4}-\d{2}-\d{2}', _date):
            return datetime.strptime(_date[:10], '%Y-%m-%d')
        elif re.match(r'^\d{2}.\d{2}.\d{4}', _date):
            return datetime.strptime(_date, '%d.%m.%Y')
        elif re.match(r'^\d{2}.\d{2}.\d{2}', _date):
            return datetime.strptime(_date, '%d.%m.%y')


def parse_json(string):
    return json.loads(string)


def parse_short_date(_date: str, year=None):
    if not year:
        year = get_current_year()
    _tmp = _date.zfill(4)
    return parse_date(f"{year}-{_tmp[2:4]}-{_tmp[0:2]}")


def parse_file_name(_data, _default=None):
    if re.match(r'^[a-zA-Z0-9äÄöÖüÜß&()/\-_. ]*$', _data):
        return _data.replace(" ", "_")
    elog(f"Bad Filename: {_data}")
    return _default


def parse_float(value, default=None, formated=True):
    """
    Safely parses a string or numeric value and returns it as a float.
    Handles different formats including comma and dot as decimal separators.

    :param value: The value to be parsed
    :return: The value converted to float, or None if conversion is not possible
    """
    if value is None:
        return default

    try:

        if isinstance(value, (int, float)):
            return float(value)

        if formated:
            if ',' in value and '.' in value:
                value = value.replace('.', '').replace(',', '.')

            elif ',' in value:
                value = value.replace(',', '.')

        return float(value)
    except ValueError:
        return default


def parse_boolean(value):
    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        if value.lower() == "true" or value == "1":
            return True
        if value.lower() == "none":
            return None
    return False


def parse_int(value, default=None):
    if value == "None" or value is None:
        return default
    if value != value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def parse_split_str(value: str, split_char) -> list:
    if not value:
        elog("Invalid Value for function 'parse_split_str'!")
        return []
    if split_char in value:
        return value.split(split_char)
    return [value]


def extract_float(text):
    pattern = r"^-?\d{1,}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?"
    match = re.search(pattern, text)
    if match:
        return float(match.group().replace('.', '').replace(',', '.'))
    return None


def clean_ip(ip):
    if ip[-1] == "*":
        return ip
    pos = ip[4:].index('.')
    if pos:
        return f"{ip[:6 + pos]}*"
    return ip


def json_encoder(obj):
    """JSON serializer for objects not serializable by default json code"""

    if isinstance(obj, datetime):
        return obj.strftime("%Y-%m-%d, %H:%M:%S")
    raise TypeError("Type %s not serializable" % type(obj))


def get_image_as_base64(_fpath: str):
    if not os.path.exists(_fpath):
        elog(f"File doesn't exist! '{_fpath}'")
        return ""

    with open(_fpath, "rb") as image:
        return f"data:image/png;base64,{base64.b64encode(image.read()).decode('utf-8')}"


def comparator(value_1, value_2, _comparator):
    if not value_1:
        return False
    if not value_2:
        return False
    if _comparator == "gt":
        return value_1 > value_2
    elif _comparator == "gte":
        return value_1 >= value_2
    elif _comparator == "lt":
        return value_1 < value_2
    elif _comparator == "lte":
        return value_1 <= value_2
    elif _comparator == "eq":
        return value_1 == value_2
    else:
        raise ValueError(f"Invalid comparator: {_comparator}")


def is_utf16(file_path):
    with open(file_path, 'rb') as file:
        first_bytes = file.read(2)
        return first_bytes.startswith(b'\xFF\xFE') or first_bytes.startswith(b'\xFE\xFF')


def get_extension(filename):
    i = filename.rindex(".")
    return filename[i-1:]



def find_uploaded_file(base_dir, filename_pattern):
    _base_name = os.path.basename(filename_pattern)
    for root, _, files in os.walk(base_dir):
        for filename in fnmatch.filter(files, _base_name):
            return os.path.join(root, filename)
    return None


def pretty_sizeof(num, suffix="b"):
    if abs(num) < 1024.0:
        return f"{(num / 1024):3.1f}K{suffix}"
    for unit in ["", "K", "M", "G", "T"]:
        if abs(num) < 1024.0:
            return f"{num:3.1f}{unit}{suffix}"
        num /= 1024.0
    return f"{num:.1f}Y{suffix}"


def pretty_date(_date: datetime):
    from progeo.settings import PRETTY_DATE_FORMAT
    if not _date:
        return "???"
    return str(_date.strftime(PRETTY_DATE_FORMAT))


def pretty_now():
    return pretty_date(datetime.now())


def get_account_id_from_url(url):
    try:
        _part = url[10:]
        _index = _part.index('/')
        dlog("get_account_id_from_url", _part[:_index])
        return int(_part[:_index])
    except ValueError:
        return 0


def _has_valid(txt, regex):
    result = re.search(regex, txt)
    if result:
        _from, _to = result.span()
        return result.string[_from: _to], result.span()
    return None, None


def has_valid_replacer(txt):
    return _has_valid(txt, regex_has_replacer)


def has_valid_mail(txt):
    return _has_valid(txt, regex_has_mail)


def has_valid_link(txt):
    return _has_valid(txt, regex_has_link)


def has_valid_integer(txt):
    return _has_valid(txt, regex_first_integer)


def replace_matches(data, txt):
    while True:
        key, pos = has_valid_replacer(txt)
        if not key:
            break
        s, e = pos
        _value = data.get(key)

        if not _value:
            txt = txt[:s] + txt[e:]
        else:
            dlog(key, "=>", _value, type(_value))
            if isinstance(_value, list):
                return txt, _value
            elif isinstance(_value, dict):
                txt = txt[:s] + _value.get("name", "") + txt[e:]
            elif isinstance(_value, float):
                txt = f"{txt[:s]}{_value:.2f}{txt[e:]}"
            else:
                # TODO add formating
                txt = txt[:s] + str(_value) + txt[e:]

    return txt, None


def get_cleaned_name(name):
    return re.sub(r'\W+', '_', name)


def get_file_creation_time(file_path):
    try:
        # Get the creation timestamp of the file
        creation_timestamp = os.path.getctime(file_path)

        # Convert the timestamp to a datetime object
        return datetime.fromtimestamp(creation_timestamp)

    except FileNotFoundError:
        return None  # Handle the case where the file does not exist


def calc_hash_from_dict(_data):
    # return hashlib.sha256(str.encode(json.dumps(_data))).hexdigest()
    return hashlib.md5(
        str.encode(json.dumps(_data, default=DjangoJSONEncoder().default, sort_keys=True, indent=4))).hexdigest()


def calc_cell_letter(row=0):
    return chr(row + 65)


def generate_hash(length=64):
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def convert_backup_date_to_timestamp(date_list) -> int:
    """
    Example: ['2023', '10', '04', '225155'] => 1696452715
    """
    from django.utils.timezone import make_aware

    date_string = ''.join(date_list[:3]) + ' ' + date_list[3]
    date_time = datetime.strptime(date_string, '%Y%m%d %H%M%S')

    return int(make_aware(date_time).timestamp())
