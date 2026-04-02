import os


def save_clean_path(_path):
    """
    Prevents malicious backtracking?
    :param _path:
    :return:
    """
    return os.path.normpath(_path)
