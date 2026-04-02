from PIL import Image
from PIL.ExifTags import TAGS, GPSTAGS
import math

from progeo.v1.helper import is_image


def haversine_distance_m(lat1, lng1, lat2, lng2):
    """
    Returns distance in meters between two WGS84 coordinates.
    """
    R = 6371000  # earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)

    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c


def _rational_to_float(x):
    """Convert ExifRational, tuple, or number to float."""
    try:
        # Pillow IFDRational has numerator/denominator attributes
        return float(x)
    except Exception:
        # Fallback for tuple or list
        return x[0] / x[1]


def _convert_to_degrees(value):
    """
    GPS coordinates may come as:
    - ( (deg_num, deg_den), (min_num, min_den), (sec_num, sec_den) )
    - [IFDRational, IFDRational, IFDRational]
    - a mix
    """
    d = _rational_to_float(value[0])
    m = _rational_to_float(value[1])
    s = _rational_to_float(value[2])
    return d + (m / 60.0) + (s / 3600.0)


def get_gps_from_image(path):
    if not is_image(path):
        return None

    img = Image.open(path)
    exif = img._getexif()
    if not exif:
        return None

    gps_info = {}
    for tag, val in exif.items():
        tag_name = TAGS.get(tag)
        if tag_name == "GPSInfo":
            for gps_tag in val:
                name = GPSTAGS.get(gps_tag)
                gps_info[name] = val[gps_tag]

    if "GPSLatitude" in gps_info and "GPSLongitude" in gps_info:
        lat = _convert_to_degrees(gps_info["GPSLatitude"])
        lng = _convert_to_degrees(gps_info["GPSLongitude"])

        # Hemisphere
        if gps_info.get("GPSLatitudeRef") == "S":
            lat = -lat
        if gps_info.get("GPSLongitudeRef") == "W":
            lng = -lng

        return {"lat": lat, "lng": lng}

    return None
