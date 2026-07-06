import os
import numpy as np
import pandas as pd

from django.core.management.base import BaseCommand


from progeo.helper.basics import dlog
from progeo.v1.legacy.executor import parse_sample_timestamp
from progeo.v1.legacy.helper_resistance import MAX_JSON_SAFE_RESISTANCE_OHM
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement


class Command(BaseCommand):
    help = 'Patches for live data'

    def add_arguments(self, parser):
        parser.add_argument("-p", "--patch",
                            help="Select a patch to run",
                            default=None)

    def handle(self, *args, **options):

        patch = options.get("patch")

        if patch == "fix_dragino_usage":
            imei = "863663069840180"

            measurements = ProgeoMeasurement.objects.filter(device__raw_hash=imei, last_updated__isnull=True)

            for m in measurements:
                data = m.raw_data
                row = data.get("raw", {}).get("1", [0, 0, 0])

                _, _, ts = row[0], row[1], row[2]
                m.last_updated = parse_sample_timestamp(ts)

                if len(data["resistance_rows"]) >= 1:
                    sample = data["resistance_rows"][0]
                    m.resistance_idc = sample.get("r_idc_ohm", MAX_JSON_SAFE_RESISTANCE_OHM)
                    m.resistance_vdc = sample.get("r_vdc_ohm", MAX_JSON_SAFE_RESISTANCE_OHM)
                    m.voltage = sample.get("vdc_intput", -1)

                m.save()

        dlog("DONE!")
