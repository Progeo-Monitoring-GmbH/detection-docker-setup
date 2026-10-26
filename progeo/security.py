import os


def save_clean_path(_path):
    """
    Normalizes a path. Does NOT keep it inside any directory - use
    safe_join() for paths built from request data.
    :param _path:
    :return:
    """
    return os.path.normpath(_path)


def safe_join(base, *parts):
    """`parts` joined onto `base`, or None if the result would leave `base`
    ("..", absolute parts, symlinks pointing outside)."""
    base_real = os.path.realpath(base)
    try:
        joined = os.path.realpath(os.path.join(base_real, *[str(part) for part in parts]))
    except (TypeError, ValueError):
        return None
    if joined != base_real and not joined.startswith(base_real + os.sep):
        return None
    return joined
