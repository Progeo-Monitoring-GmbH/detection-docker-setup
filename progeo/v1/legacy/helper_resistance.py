"""
Berechnung des Sensor-Widerstands aus Dragino IDC/VDC-Messwerten.

Formeln (siehe DM-Sensoren_mit_Dragino_auslesen.docx):

IDC (Stromschleife, 0-20mA @ 12V):
    R = U_in / I_meas          [I in A]

VDC (Spannungsteiler, mit Korrektur):
    R = (U_vdc * R_vor * R_imp) / (R_imp * (U_in - U_vdc) - U_vdc * R_vor)

    R_vor = 22 kOhm  (Vorwiderstand)
    R_imp = 638 kOhm (Korrekturfaktor / Eingangsimpedanz)
    U_in  = 12 V     (angelegte Versorgungsspannung)
"""

import math

U_IN = 12.0        # V, angelegte Versorgungsspannung
R_VOR = 22_000     # Ohm, Vorwiderstand des Spannungsteilers
R_IMP = 638_000    # Ohm, Korrekturfaktor (Eingangsimpedanz ADC)
MAX_JSON_SAFE_RESISTANCE_OHM = 19_999_999.9


def _json_safe_resistance(value):
    if value is None:
        return None

    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(numeric):
        return MAX_JSON_SAFE_RESISTANCE_OHM
    if numeric < 0:
        return None
    if numeric > MAX_JSON_SAFE_RESISTANCE_OHM:
        return MAX_JSON_SAFE_RESISTANCE_OHM
    return numeric


def calc_r_idc(idc_intput, u_in=U_IN):
    """
    Berechnet den Widerstand aus dem IDC-Messwert.
    idc_intput wird als mA erwartet (Dragino-Payload-Feld).
    Gibt None zurück, wenn kein Strom fließt (0 mA -> IDC-Kanal nicht aktiv
    bzw. Widerstand geht gegen unendlich).
    """
    if idc_intput is None or idc_intput <= 0:
        # Open circuit / no current: keep JSON-safe sentinel instead of inf.
        return MAX_JSON_SAFE_RESISTANCE_OHM
    i_a = idc_intput / 1000.0  # mA -> A
    return u_in / i_a


def calc_r_vdc(vdc_intput, r_vor=R_VOR, r_imp=R_IMP, u_in=U_IN):
    """
    Berechnet den Widerstand aus dem VDC-Messwert (Spannungsteiler),
    korrigiert um die Eingangsimpedanz R_imp (638 kOhm).
    """
    if vdc_intput is None:
        return None
    u = vdc_intput
    denom = r_imp * (u_in - u) - u * r_vor
    if denom <= 0:
        return None  # außerhalb des gültigen Messbereichs
    return (u * r_vor * r_imp) / denom


def calc_resistances(vdc_intput, idc_intput):
    """
    Nimmt die beiden Rohwerte aus dem Sensor-Payload entgegen und gibt
    ein Dict mit beiden berechneten Widerständen zurück.
    """
    r_idc = _json_safe_resistance(calc_r_idc(idc_intput))
    r_vdc = _json_safe_resistance(calc_r_vdc(vdc_intput))
    return {
        "vdc_intput": vdc_intput,
        "idc_intput": idc_intput,
        "r_idc_ohm": r_idc,
        "r_vdc_ohm": r_vdc,
    }


def format_result(result):
    r_idc = result["r_idc_ohm"]
    r_vdc = result["r_vdc_ohm"]
    r_idc_str = f"{r_idc/1000:.2f} kOhm" if r_idc is not None else "n/a (kein Stromfluss)"
    r_vdc_str = f"{r_vdc/1000:.2f} kOhm" if r_vdc is not None else "n/a (außerhalb Messbereich)"
    return (
        f"VDC={result['vdc_intput']} V, IDC={result['idc_intput']} mA  ->  "
        f"R_IDC={r_idc_str}, R_VDC(korr.)={r_vdc_str}"
    )