import base64
import csv
import json
import os
import pathlib
import random
import re
import secrets
import string
from datetime import datetime, timedelta

import time
from json import JSONDecodeError

from colorama import Fore, Style
from colorama.ansi import AnsiFore
from rest_framework.response import Response
from time import gmtime, strftime
from datetime import date

from progeo.helper.exceptions import MissingEnvironmentVariableError
from progeo.security import save_clean_path

MAX_LOG_LENGTH = 2500


class RequestSuccess(Response):
    def __init__(self, data=None, **kwargs):
        if data is None:
            data = {}
        data['success'] = True
        super().__init__(data=data, status=200, **kwargs)


class RequestFailed(Response):
    def __init__(self, data=None, **kwargs):
        if data is None:
            data = {}
        data['success'] = False
        super().__init__(data=data, status=400, **kwargs)


# ######################################################################## #
# #####  H E L P E R - F U N C T I O N S ################################# #
# ######################################################################## #


def _cleaned_msg(*msg):
    _msg = ' '.join(str(x) for x in msg)
    if len(_msg) > MAX_LOG_LENGTH:
        return f"[SHORTED len={len(_msg)}] {_msg[:MAX_LOG_LENGTH]}..."
    return _msg


def _log(*msg, color: AnsiFore, tag):
    """
    blue console-output
    :param msg: message to be printed
    :param color: color of output
    :param tag: leading tag for the print line
    """
    _now = time.time()
    time_with_ms = "%s.%03d" % (time.strftime('%X', time.localtime(_now)), _now % 1 * 1000)
    print(color, time_with_ms, f"{tag: <15}", *msg, Style.RESET_ALL)


def dlog(*msg, tag: str = "[DEBUG]", active=True, logger=None):
    if active:
        _msg = _cleaned_msg(*msg)
        if logger:
            logger.debug(f"{tag: <15} {_msg}")
        else:
            _log(_msg, color=Fore.WHITE, tag=tag)


def ilog(*msg, tag: str = "[INFO]", active=True):
    if active:
        _msg = _cleaned_msg(*msg)
        _log(_msg, color=Fore.BLUE, tag=tag)
        # logger = logging.getLogger("progeo")
        # logger.info(f"{tag: <15} {_msg}")


def elog(*msg, tag: str = "[ERROR]", active=True):
    if active:
        _msg = _cleaned_msg(*msg)
        _log(_msg, color=Fore.RED, tag=tag)
        # logger = logging.getLogger("progeo")
        # logger.error(f"{tag: <15} {_msg}")


def flog(*msg, tag: str = "[FATAL]", active=True):
    if active:
        _msg = _cleaned_msg(*msg)
        _log(_msg, color=Fore.RED, tag=tag)
        # logger = logging.getLogger("progeo")
        # logger.fatal(f"{tag: <15} {_msg}")


def okaylog(*msg, tag: str = "[OK]", active=True):
    if active:
        _msg = _cleaned_msg(*msg)
        _log(_msg, color=Fore.GREEN, tag=tag)
        # logger = logging.getLogger("progeo")
        # logger.info(f"{tag: <15} {_msg}")


def wlog(*msg, tag: str = "[???]", active=True):
    if active:
        _msg = _cleaned_msg(*msg)
        _log(_msg, color=Fore.YELLOW, tag=tag)
        # logger = logging.getLogger("progeo")
        # logger.warning(f"{tag: <15} {_msg}")


def breaklog(show_time=False):
    """
    blue console-output
    """
    if show_time:
        _log(f'{strftime("%Y-%m-%d %H:%M:%S", gmtime())}\n', color=Fore.BLUE, tag="#")
    _log("=====================================================\n\n", color=Fore.BLUE, tag="#")


# ######################################################################## #


def read_env(file_path: str):
    """
    read given '.env'-file with enviroment variables
    """
    try:
        with open(file_path, encoding='utf-8') as f:
            content = f.read()
    except IOError:
        content = ''

    for line in content.splitlines():
        m1 = re.match(r'\A([A-Za-z_0-9]+)=(.*)\Z', line)
        if m1:
            key, val = m1.group(1), m1.group(2)
            m2 = re.match(r"\A'(.*)'\Z", val)
            if m2:
                val = m2.group(1)
            m3 = re.match(r'\A"(.*)"\Z', val)
            if m3:
                val = re.sub(r'\\(.)', r'\1', m3.group(1))
            os.environ.setdefault(key, val)


def read_env_as_dict(file_path: str):
    """read given '.env'-file with environment variables
    """
    data = {}
    try:
        with open(file_path) as f:
            content = f.read()
    except IOError:
        content = ''

    for line in content.splitlines():
        m1 = re.match(r'\A([A-Za-z_0-9]+)=(.*)\Z', line)
        if m1:
            key, val = m1.group(1), m1.group(2)
            m2 = re.match(r"\A'(.*)'\Z", val)
            if m2:
                val = m2.group(1)
            m3 = re.match(r'\A"(.*)"\Z', val)
            if m3:
                val = re.sub(r'\\(.)', r'\1', m3.group(1))
            data.update({key: val})

    return data


def save_check_dir(*args) -> str:
    _dir = os.path.join(*args)
    if not os.path.isdir(_dir):  # pragma: no cover
        dlog(_dir, tag="[SAVE-CHECK]")
        pathlib.Path(_dir).mkdir(parents=True, exist_ok=True)
    return str(_dir)


def copy_file(src, dst, acknowledge=False):
    import shutil
    if acknowledge:
        okaylog(src, "\tto ", dst, tag="[COPY]")
    shutil.copyfile(src, dst)


def delete_file(_file, acknowledge=False):
    """
    deletes the file
    """
    try:
        os.remove(_file)
        if acknowledge:
            ilog(f"Deleted: '{_file}'")
    except FileNotFoundError as e:
        elog(f"Can not delete File: '{_file}'")
        elog(e, tag="[FileNotFoundError]")
    except PermissionError as e:
        elog(f"Can not delete File: '{_file}'")
        elog(e, tag="[PermissionError]")


def clear_dir(_dir):
    if os.path.isdir(_dir):
        for f in os.listdir(_dir):
            delete_file(os.path.join(_dir, f))


# ######################################################################## #


def build_abs_path(path_list: list) -> str:
    from progeo.settings import MEDIA_ROOT
    abs_path = os.path.abspath(MEDIA_ROOT)
    return os.path.join(abs_path, *path_list)


def get_code_image(file):
    return build_abs_path(["codered", "images", file])


# ######################################################################## #


def min_max(value, _min, _max):
    if value < _min:
        return _min

    if value > _max:
        return _max

    return value


def sleep_ms(delay=0, msg=None):
    """
    sleeps for a specific amount of ms
    :param msg:
    :param delay: Delay as String in ms or 'None' as string
    """
    if msg:
        dlog(f"Sleep for {delay} | From: {msg}")

    if delay == 0 or (isinstance(delay, str) and delay == "---"):
        time.sleep(3)
    else:
        time.sleep(int(delay) / 1000)


def _get_files_from_path(_path, regex=None, order=False, basename=False):

    if not os.path.exists(_path):
        elog(f"Path does not exist! >>{_path}<<")
        return []

    dlog("_get_files_from_path", os.listdir(_path))
    _files = sorted(os.listdir(_path)) if order else os.listdir(_path)

    if not regex:
        if basename:
            return _files
        return [get_relative_path(os.path.join(_path, f)) for f in _files]

    pattern = re.compile(regex)

    if basename:
        return [f for f in _files if pattern.match(f)]

    return [get_relative_path(os.path.join(_path, f)) for f in _files if pattern.match(f)]


def get_relative_path(_path):
    _index = _path.index("media")
    return _path[_index:]


def get_pdf_factor_path(target, account, _file, save=True):
    if save:
        _path = build_abs_path(["pdf-factory", target, str(account)])
        save_check_dir(_path)
        return save_clean_path(os.path.join(_path, _file))
    return save_clean_path(build_abs_path(["pdf-factory", target, account, _file]))


def get_templates(account, regex=None):
    _path = build_abs_path(["pdf-factory", "src", str(account)])
    if os.path.exists(_path):
        return _get_files_from_path(_path, regex), get_relative_path(_path)
    return [], get_relative_path(_path)


def get_pdf_attachments(account, ids: list):
    return get_attachments(account, ids, r'^.*pdf$')


def get_attachments(account, ids: list, regex=None):
    from progeo.settings import BASE_DIR
    _path = build_abs_path(["pdf-factory", "target", str(account)])
    files = _get_files_from_path(_path, regex)
    dlog("Raw ATTACHMENT-FILES:", files, ids)
    distincts = set()
    attachments = []
    for f in files:
        distincts.add(f[:-9])

    dlog("distinct-FILES:", distincts, ids)
    for attachment in distincts:
        success = True
        for _id in ids:

            attachment_path = os.path.join(BASE_DIR, f"{attachment}-{_id:04d}.pdf")
            if not os.path.exists(attachment_path):
                elog(f"attachment_path='{attachment_path}' for id={_id:04d}", tag="[MISSING]")
                success = False
                break
        if success:
            attachments.append(os.path.basename(attachment))
    dlog("Final ATTACHMENT-FILES:", attachments, ids)

    return attachments


def get_today(as_str=False):
    if as_str:
        return date.today().strftime("%Y-%m-%d")
    return date.today()


def get_first_of(month):
    year = get_current_year()
    return datetime(year, month, 1).date()


def get_date(y, m, d):
    return datetime(y, m, d).date()


def get_current_year():
    return date.today().year


def generate_random_string(length=64):
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


def remove_a_from_b(a: list, b: list) -> list:
    return [elem for elem in b if elem not in a]


def json_encoder(obj):
    """JSON serializer for objects not serializable by default json code"""

    if isinstance(obj, datetime):
        return obj.strftime("%Y-%m-%d, %H:%M:%S")
    raise TypeError("Type %s not serializable" % type(obj))


def check_raise_config(wanted_keys: list, existing_keys: list):
    cleaned = {}
    for env in wanted_keys:
        if env not in existing_keys:
            raise MissingEnvironmentVariableError(f"{env} is not in ENV!")
        cleaned.update({env: os.getenv(env)})

    return cleaned


def check_break_missing_envs(env: str):
    value = os.getenv(env)
    if value:
        return value

    msg = f"Failed because of missing ENV '{env}'"
    elog(msg)
    raise MissingEnvironmentVariableError(msg)


def write_json(_fpath, data):
    with open(_fpath, "w", encoding="utf-8") as json_file:
        json.dump(data, json_file, indent=4, default=json_encoder, ensure_ascii=False)


def write_csv(_path, data, fields=None):
    with open(_path, mode="w", newline="", encoding="utf-8") as csv_file:
        if not fields:
            csv_file.write(data)
        else:
            csv_writer = csv.DictWriter(csv_file, fieldnames=fields, quoting=csv.QUOTE_ALL)
            csv_writer.writeheader()
            csv_writer.writerows(data)
    return _path


def read_json(_fpath):
    if os.path.exists(_fpath):
        try:
            with open(_fpath, mode="r", encoding="utf-8") as json_file:
                return json.load(json_file)
        except JSONDecodeError as e:
            elog("_fpath", _fpath)
            elog(e)
    else:
        elog(f"File doesn't exist! '{_fpath}'")
    return {}


def get_image_as_base64(_fpath: str):
    if not os.path.exists(_fpath):
        elog(f"File doesn't exist! '{_fpath}'")
        return ""

    with open(_fpath, "rb") as image:
        return f"data:image/png;base64,{base64.b64encode(image.read()).decode('utf-8')}"


def clean_field(_field):
    _value = str(_field)
    if _value == "nan":
        return None
    _str = _value.strip()[0:254]
    return _str
    # return "".join([i if ord(i) < 128 else "?" for i in _field.strip()[0:254]])


def fifty_fifty():
    "Return 0 or 1 with 50% chance for each"
    return random.randrange(2)



def generate_dates(start_date_str, end_date_str):
    # Convert string dates to datetime objects
    start_date = datetime.strptime(start_date_str, "%d.%m.%Y")
    end_date = datetime.strptime(end_date_str, "%d.%m.%Y")

    # Generate all dates between the start and end dates
    dates = []
    current_date = start_date
    while current_date <= end_date:
        dates.append(current_date.date())
        current_date += timedelta(days=1)

    return dates
