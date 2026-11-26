"""The models of the Werk app (progeo/werk/apps.py): ProGeo's own factory
data, linked with Airtable - in "default" only.

- FactorySensor, SiteMeasurement: the dm sensors' factory values (R_Werk) and
  the manuSensor app's site measurements (helper/manusensor.py,
  helper/airtable_dm_sensors.py).
- WerkUser, ProductionSheet, ProductionEntry, ProductionProgress, Roll,
  RollPhoto: the digital production record dm (docs/fertigung.md,
  helper/production.py, rolls.py, werk_users.py, production_overview.py),
  keyed by Airtable record ids.

Moved from the progeo app (progeo/migrations/0084_move_to_werk.py); the
constraint and index names kept their progeo_ prefix.
"""

from django.contrib.auth.models import User
from django.db import models


class FactorySensor(models.Model):
    """A smartex dm sensor as the factory measured it (manuSensor app, see
    helper/manusensor.py): the band's sensor resistance R_Werk, the project it
    was made for and its NFC tag. Stored by the factory app (POST
    /v1/werk/sensoren/) or `manage.py import_factory_sensors`; the site app
    compares its re-measurement with it. Keyed by (project number, sensor
    number) - the location may not exist yet when the band is produced.
    Also created from the Airtable table "dm Sensoren" (staff page import,
    `manage.py import_dm_sensors` - helper/airtable_dm_sensors.py): those
    have no R_Werk until the factory app or a CSV sends it.
    Lives in "default" (ProGeo's own production data, not a customer's)."""

    project_id = models.IntegerField()
    # 6 digits with leading zeros ("000123") - Airtable "dm Sensoren" Nr.
    sensor = models.CharField(max_length=6)
    band = models.CharField(max_length=32, null=True, blank=True)
    # NTAG21x UID, hex upper case without separators - a check against
    # swapped or copied tags, not the key.
    tag_uid = models.CharField(max_length=20, null=True, blank=True)
    # None: not measured in the factory yet (imported from Airtable) - the
    # site measurements are answered "unbekannt" until it is known.
    r_werk_ohm = models.PositiveIntegerField(null=True, blank=True)
    measured_at = models.DateTimeField(null=True, blank=True)
    # The "dm Sensoren" row it was imported from / linked to, its Nr. as
    # written there ("51 H4" -> sensor 000051), the production order
    # ("PROD_dm-Breitband_7025_34") and the band's length in metres.
    airtable_record_id = models.CharField(max_length=32, null=True, blank=True, db_index=True)
    airtable_nr = models.CharField(max_length=32, null=True, blank=True)
    production_order = models.CharField(max_length=64, null=True, blank=True)
    length_m = models.FloatField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project_id", "sensor"], name="progeo_factory_sensor_unique"),
            models.UniqueConstraint(
                fields=["project_id", "tag_uid"], condition=models.Q(tag_uid__isnull=False),
                name="progeo_factory_sensor_tag_unique",
            ),
        ]

    def __str__(self):
        r_werk = f"{self.r_werk_ohm} Ω" if self.r_werk_ohm is not None else "R_Werk fehlt"
        return f"{self.project_id}/{self.sensor} ({r_werk})"


class SiteMeasurement(models.Model):
    """A re-measurement of a dm sensor on the construction site, sent by the
    manuSensor app (POST /v1/werk/baustelle/<projekt>/messungen): what the app sent
    (payload, the main values as columns) and what the backend answered
    (status from the deviation to R_Werk). Idempotent by mess_id - the app
    resends until it has an answer. Copied to Airtable afterwards
    (airtable_* - helper/manusensor.push_to_airtable). Lives in "default"."""

    class Status(models.TextChoices):
        OK = "ok", "OK"
        CHECK = "pruefen", "Prüfen"
        DEFECT = "defekt", "Defekt"
        UNKNOWN = "unbekannt", "Unbekannt"

    mess_id = models.UUIDField(unique=True)
    project_id = models.IntegerField(db_index=True)
    sensor = models.CharField(max_length=6)
    # The location of the project number (pk in its account database).
    location_pk = models.IntegerField(null=True, blank=True)
    factory_sensor = models.ForeignKey(
        FactorySensor, on_delete=models.SET_NULL, null=True, blank=True, related_name="site_measurements"
    )
    measured_at = models.DateTimeField()
    received_at = models.DateTimeField(auto_now_add=True)
    identification = models.CharField(max_length=10)
    trigger = models.CharField(max_length=10)
    tag_uid = models.CharField(max_length=20, null=True, blank=True)
    r_ohm = models.PositiveIntegerField(null=True, blank=True)
    r_status = models.CharField(max_length=12)
    device_id = models.CharField(max_length=16)
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    # The request as received - a resend must be the same (else 409).
    payload = models.JSONField()
    # The answer.
    r_werk_ohm = models.PositiveIntegerField(null=True, blank=True)
    delta_percent = models.FloatField(null=True, blank=True)
    tolerance_percent = models.FloatField()
    status = models.CharField(max_length=10, choices=Status)
    # The tag on the band is not the one the factory gave the sensor.
    tag_mismatch = models.BooleanField(default=False)
    # Airtable "Baustellenmessungen" (settings.AIRTABLE_SITE_MEASUREMENTS_TABLE).
    airtable_record_id = models.CharField(max_length=20, null=True, blank=True)
    airtable_synced_at = models.DateTimeField(null=True, blank=True)
    airtable_error = models.TextField(null=True, blank=True)

    class Meta:
        ordering = ["-pk"]
        indexes = [models.Index(fields=["project_id", "sensor"], name="progeo_site_meas_sensor")]

    def __str__(self):
        return f"{self.project_id}/{self.sensor} {self.status} ({self.mess_id})"


# ---------------------------------------------------------------------------- digital production record dm
# docs/fertigung.md (Digitales Fertigungsprotokoll dm): the factory fills the protocol of
# a "PA: dm" order in the manuSensor app (helper/production.py, rolls.py,
# werk_users.py). All in "default", keyed by Airtable record ids.


class WerkUser(models.Model):
    """A factory worker's backend account, linked to their Airtable
    "Ressourcen" row (`manage.py sync_werk_users`, helper/werk_users.py).
    Staff accounts may have one too (for "Produziert von")."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="werk_user")
    airtable_resource_id = models.CharField(max_length=20, unique=True, null=True, blank=True)
    name = models.CharField(max_length=150, blank=True, default="")
    # Empty: the initials of the name ("Max Muster" -> "MM").
    kuerzel = models.CharField(max_length=8, blank=True, default="")
    # The sync deactivated the account (box unticked) - only those it reactivates.
    deactivated_by_sync = models.BooleanField(default=False)
    synced_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.name or self.user.username} ({self.airtable_resource_id or '-'})"


class ProductionSheet(models.Model):
    """A released sheet (20 sensors, one box) of a dm order: released = its
    sensors are produced. Exists only once released."""

    order_record_id = models.CharField(max_length=20)
    order_id = models.CharField(max_length=100)
    blatt = models.PositiveIntegerField()
    # The sheet's sensors when it was released ("dm Sensoren" record ids).
    sensor_record_ids = models.JSONField(default=list)
    # How many sheets the order had then - "every sheet released" = order done.
    blaetter_gesamt = models.PositiveIntegerField()
    freigegeben_von = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    freigegeben_am = models.DateTimeField()
    auffaellig_bestaetigt = models.JSONField(default=list, blank=True)
    geraet_id = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    airtable_synced_at = models.DateTimeField(null=True, blank=True)
    airtable_error = models.TextField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["order_record_id", "blatt"], name="progeo_production_sheet_unique"),
        ]

    def __str__(self):
        return f"{self.order_id} Blatt {self.blatt}"


class ProductionEntry(models.Model):
    """The measured values of one sensor of a dm order (① ② ③, metering,
    rolls) - a draft until its sheet is released (`sheet`)."""

    sensor_record_id = models.CharField(max_length=20, unique=True)
    order_id = models.CharField(max_length=100)
    order_record_id = models.CharField(max_length=20, db_index=True)
    project_id = models.IntegerField(null=True, blank=True)
    sensor = models.CharField(max_length=6)
    # status "ok" (ohm set) | "offen" (ohm null) | null: not measured yet.
    r_platine_ohm = models.PositiveIntegerField(null=True, blank=True)
    r_platine_status = models.CharField(max_length=8, null=True, blank=True)
    r_aufgespult_ohm = models.PositiveIntegerField(null=True, blank=True)
    r_aufgespult_status = models.CharField(max_length=8, null=True, blank=True)
    r_kurzschluss_ohm = models.PositiveIntegerField(null=True, blank=True)
    r_kurzschluss_status = models.CharField(max_length=8, null=True, blank=True)
    metrierung_m = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    metrierung_manuell = models.BooleanField(default=False)
    messband_rolle = models.CharField(max_length=32, null=True, blank=True)
    vorlauf_rolle = models.CharField(max_length=32, null=True, blank=True)
    erfasst_von = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    erfasst_am = models.DateTimeField()
    quelle = models.CharField(max_length=10)
    geraet_id = models.CharField(max_length=64, blank=True, default="")
    gespeichert_am = models.DateTimeField(auto_now=True)
    sheet = models.ForeignKey(
        ProductionSheet, on_delete=models.SET_NULL, null=True, blank=True, related_name="entries"
    )
    nach_freigabe_geaendert = models.BooleanField(default=False)
    # The sensor's lengths in "dm Sensoren" when it was saved (Länge, Vorlauf
    # gesamt) - the staff page's meters per day without asking Airtable.
    laenge_m = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    vorlauf_m = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    # "QS-Prüfung" of "dm Sensoren" (helper/production_overview.py): set on
    # release (OK / Prüfen from the values), decided by staff (qs_manuell).
    qs_status = models.CharField(max_length=12, null=True, blank=True)
    qs_manuell = models.BooleanField(default=False)
    qs_von = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    qs_am = models.DateTimeField(null=True, blank=True)
    # Airtable "dm Sensoren" - only released entries are copied.
    airtable_synced_at = models.DateTimeField(null=True, blank=True)
    airtable_error = models.TextField(null=True, blank=True)

    def __str__(self):
        return f"{self.order_id} / {self.sensor}"


class ProductionProgress(models.Model):
    """The newest progress report of the app for a dm order (one per order)."""

    order_record_id = models.CharField(max_length=20, unique=True)
    order_id = models.CharField(max_length=100)
    sensoren_gesamt = models.PositiveIntegerField(null=True, blank=True)
    geraet_id = models.CharField(max_length=64)
    benutzer = models.CharField(max_length=150, blank=True, default="")
    zeitpunkt = models.DateTimeField()
    aktives_blatt = models.PositiveIntegerField(null=True, blank=True)
    erfasst = models.PositiveIntegerField(default=0)
    ungesendet = models.PositiveIntegerField(default=0)
    freigegebene_blaetter = models.JSONField(default=list, blank=True)
    rollen = models.JSONField(default=list, blank=True)
    empfangen_am = models.DateTimeField(auto_now=True)
    # "App-Fortschritt" in "PA: dm" at most every 5 minutes.
    airtable_gesendet_am = models.DateTimeField(null=True, blank=True)
    airtable_error = models.TextField(null=True, blank=True)

    def __str__(self):
        return f"{self.order_id}: {self.erfasst} ({self.benutzer})"


class Roll(models.Model):
    """A roll of measuring band (200 m) or lead cable (1000 m): rolls move
    between devices and orders, so the register lives in the backend."""

    class Type(models.TextChoices):
        MESSBAND = "messband", "Messband"
        VORLAUF = "vorlauf", "Vorlauf"

    nummer = models.CharField(max_length=32, unique=True)
    typ = models.CharField(max_length=10, choices=Type.choices)
    kabeltyp = models.CharField(max_length=64, null=True, blank=True)
    nennlaenge_m = models.DecimalField(max_digits=8, decimal_places=2)
    # Lead cable: the metering printed at the start of the roll / last reported.
    start_metrierung_m = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    metrierung_m = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    # Measuring band: the rest reported (lead cable: computed).
    rest_m = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    leer = models.BooleanField(default=False)
    # Bar/QR code on the label, as scanned.
    code = models.CharField(max_length=255, null=True, blank=True, db_index=True)
    code_format = models.CharField(max_length=32, null=True, blank=True)
    zuletzt_geraet_id = models.CharField(max_length=64, null=True, blank=True)
    zuletzt_benutzer = models.CharField(max_length=150, null=True, blank=True)
    zuletzt_auftrag_id = models.CharField(max_length=100, null=True, blank=True)
    zuletzt_am = models.DateTimeField(null=True, blank=True)
    angelegt_von = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    angelegt_am = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.nummer} ({self.typ})"


class RollPhoto(models.Model):
    """A photo of a roll's label (settings.WERK_ROLL_PHOTO_DIR/<datei>)."""

    roll = models.ForeignKey(Roll, on_delete=models.CASCADE, related_name="fotos")
    foto_id = models.UUIDField(unique=True)
    datei = models.CharField(max_length=100)
    mime = models.CharField(max_length=20)
    angelegt_von = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    angelegt_am = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.roll.nummer}: {self.foto_id}"
