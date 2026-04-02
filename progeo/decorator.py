import time
from functools import wraps
from progeo.helper.basics import ilog


def has_test_coverage(wrapped_function):
    def _wrapper(*args, **kwargs):
        result = wrapped_function(*args, **kwargs)
        return result

    return _wrapper


def calc_runtime(func):
    @wraps(func)
    def _wrapper(*args, **kwargs):
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        end_time = time.perf_counter()
        total_time = end_time - start_time
        ilog(f"{total_time:.4f}s\t\trequest='{func.__name__}{args}' kwargs={kwargs}", tag="[RUNTIME]")
        return result

    return _wrapper
