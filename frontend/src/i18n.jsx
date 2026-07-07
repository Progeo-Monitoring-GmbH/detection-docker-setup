import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import Backend from 'i18next-http-backend';
import { DateTime } from 'luxon';

i18n
  // i18next-http-backend
  // loads translations from your server
  // https://github.com/i18next/i18next-http-backend
  .use(Backend)
  // detect user language
  // learn more: https://github.com/i18next/i18next-browser-languageDetector
  .use(LanguageDetector)
  // pass the i18n instance to react-i18next.
  .use(initReactI18next)
  // init i18next
  // for all options read: https://www.i18next.com/overview/configuration-options
  .init({
    debug: true,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    resources: {
      en: {
        translation: {
          backup_actions: 'Backup Actions',
          backup_reload: 'Reload Backups',
          backup_create: 'Create Backup',
          backup_delete_all: 'Delete All Backups',
          backup_available: 'Available Backups',
          imei_load_error: 'Could not load IMEI resistance data',
          imei_title: 'Display IMEI Devices',
          imei_loading: 'Loading IMEI resistance charts...',
          imei_summary:
            '{{deviceCount}} IMEI devices, {{measurementCount}} measurements with resistance',
          imei_no_measurements: 'No IMEI measurements with resistance found.',
          imei_device_id: 'Device ID',
          imei_points_latest: '{{pointCount}} points, latest:',
          imei_axis_time: 'Receive Time',
          imei_axis_resistance: 'Resistance [log Ohm]',
          profile_loading: 'Loading profile...',
          profile_title: 'User Profile',
          profile_user: 'User',
          profile_settings_button: 'Settings',
          profile_logout: 'Logout',
          profile_settings: 'Settings',
          profile_email: 'Email',
          profile_email_invalid: 'Please enter a valid email address',
          profile_language: 'Language',
          profile_saving: 'Saving...',
          profile_save_settings: 'Save Settings',
          profile_change_password: 'Change Password',
          profile_current_password: 'Current Password',
          profile_new_password: 'New Password',
          profile_confirm_password: 'Confirm Password',
          profile_save_password: 'Save Password',
          profile_load_error: 'Could not load profile',
          profile_load_success: 'Profile loaded successfully',
          profile_modal_opening: 'Opening profile settings...',
          profile_modal_reopen_hint:
            'Profile settings are closed. Use the button to open them again.',
          profile_close: 'Close',
          profile_settings_saved: 'Settings updated',
          profile_settings_saving_info: 'Saving profile settings...',
          profile_settings_error: 'Could not update settings',
          profile_password_missing: 'Please fill all password fields',
          profile_password_mismatch: 'New passwords do not match',
          profile_password_weak:
            'Password is too weak. Use at least 8 characters and multiple character sets.',
          profile_password_strength: 'Password strength',
          profile_password_strength_very_weak: 'Very weak',
          profile_password_strength_weak: 'Weak',
          profile_password_strength_medium: 'Medium',
          profile_password_strength_strong: 'Strong',
          profile_password_strength_very_strong: 'Very strong',
          profile_password_requirements_hint: 'Minimum requirements:',
          profile_password_requirement_min_length: 'At least 8 characters',
          profile_password_requirement_min_length_ok:
            'At least 8 characters - OK',
          profile_password_requirement_charset:
            'At least 3 character sets: lowercase, uppercase, digit, special character',
          profile_password_requirement_charset_ok:
            'At least 3 character sets - OK',
          profile_password_saving_info: 'Updating password...',
          profile_password_saved: 'Password updated',
          profile_password_error: 'Could not update password',
          profile_logout_info: 'Signing out...',
          profile_logout_error: 'Could not sign out',
          profile_logout_unknown_error: 'Unknown logout error',
          landing_no_modules_title: 'No modules available',
          landing_no_modules_description:
            'Your account currently has no enabled modules.',
          landing_select_title: 'Select a module',
          landing_select_description: 'Choose where you want to continue.',
          landing_module_devices: 'Devices',
          landing_module_locations: 'Locations',
          landing_module_measurements: 'Measurements',
          landing_module_imei: 'IMEI Display',
          landing_module_backup: 'Backup',
          landing_module_docker: 'Docker Status',
          landing_module_admin: 'Admin Panel',
          measurement_compare_deviation_label: 'Deviation (±1σ)',
          measurement_compare_deviation_lower_bound_label:
            'Lower deviation bound',
          measurement_compare_pair_label: 'Pair',
          measurement_compare_range_label: 'Range',
          measurement_compare_mean_label: 'Mean',
          measurement_compare_sigma_label: 'σ',
          measurement_compare_pair_sum_label: 'Pair sum',
          measurement_compare_sum_label: 'Sum',
          measurement_compare_samples_label: 'Samples',
          measurement_compare_measurement_datetime_label:
            'Measurement datetime',
          measurement_compare_measurements_included: 'Measurements included',
          measurement_compare_avg_sigma_label: 'Avg σ',
          measurement_compare_mean_avg_sigma_summary:
            'Mean: {{mean}} | Avg σ: {{avgSigma}}',
          measurement_compare_pair_index_axis: 'Pair Index',
          measurement_compare_absolute_delta_axis: 'Absolute Delta',
          measurement_compare_pair_sum_axis: 'Pair Sum',
        },
      },
      de: {
        translation: {
          backup_actions: 'Backup Actions',
          backup_reload: 'Backups neuladen',
          backup_create: 'Backup erstellen',
          backup_delete_all: 'Lösche alle Backups',
          backup_available: 'Vorhandene Backups',
          imei_load_error: 'IMEI-Widerstandsdaten konnten nicht geladen werden',
          imei_title: 'IMEI-Geräteanzeige',
          imei_loading: 'IMEI-Widerstandsdiagramme werden geladen...',
          imei_summary:
            '{{deviceCount}} IMEI-Geräte, {{measurementCount}} Messungen mit Widerstand',
          imei_no_measurements: 'Keine IMEI-Messungen mit Widerstand gefunden.',
          imei_device_id: 'Geräte-ID',
          imei_points_latest: '{{pointCount}} Punkte, zuletzt:',
          imei_axis_time: 'Empfangszeit',
          imei_axis_resistance: 'Widerstand [log Ω]',
          profile_loading: 'Profil wird geladen...',
          profile_title: 'Benutzerprofil',
          profile_user: 'Benutzer',
          profile_settings_button: 'Einstellungen',
          profile_logout: 'Logout',
          profile_settings: 'Einstellungen',
          profile_email: 'E-Mail',
          profile_email_invalid: 'Bitte eine gueltige E-Mail-Adresse eingeben',
          profile_language: 'Sprache',
          profile_saving: 'Speichern...',
          profile_save_settings: 'Einstellungen speichern',
          profile_change_password: 'Passwort ändern',
          profile_current_password: 'Aktuelles Passwort',
          profile_new_password: 'Neues Passwort',
          profile_confirm_password: 'Passwort bestätigen',
          profile_save_password: 'Passwort speichern',
          profile_load_error: 'Profil konnte nicht geladen werden',
          profile_load_success: 'Profil erfolgreich geladen',
          profile_modal_opening: 'Profileinstellungen werden geöffnet...',
          profile_modal_reopen_hint:
            'Die Profileinstellungen sind geschlossen. Mit dem Button kannst du sie wieder öffnen.',
          profile_close: 'Schließen',
          profile_settings_saved: 'Einstellungen gespeichert',
          profile_settings_saving_info:
            'Profileinstellungen werden gespeichert...',
          profile_settings_error:
            'Einstellungen konnten nicht gespeichert werden',
          profile_password_missing: 'Bitte alle Passwortfelder ausfüllen',
          profile_password_mismatch: 'Neue Passwörter stimmen nicht überein',
          profile_password_weak:
            'Passwort ist zu schwach. Verwende mindestens 8 Zeichen und mehrere Zeichensaetze.',
          profile_password_strength: 'Passwortstaerke',
          profile_password_strength_very_weak: 'Sehr schwach',
          profile_password_strength_weak: 'Schwach',
          profile_password_strength_medium: 'Mittel',
          profile_password_strength_strong: 'Stark',
          profile_password_strength_very_strong: 'Sehr stark',
          profile_password_requirements_hint: 'Mindestanforderungen:',
          profile_password_requirement_min_length: 'Mindestens 8 Zeichen',
          profile_password_requirement_min_length_ok:
            'Mindestens 8 Zeichen - OK',
          profile_password_requirement_charset:
            'Mindestens 3 Zeichensaetze: Kleinbuchstaben, Grossbuchstaben, Zahl, Sonderzeichen',
          profile_password_requirement_charset_ok:
            'Mindestens 3 Zeichensaetze - OK',
          profile_password_saving_info: 'Passwort wird aktualisiert...',
          profile_password_saved: 'Passwort aktualisiert',
          profile_password_error: 'Passwort konnte nicht aktualisiert werden',
          profile_logout_info: 'Abmeldung wird ausgeführt...',
          profile_logout_error: 'Abmeldung fehlgeschlagen',
          profile_logout_unknown_error: 'Unbekannter Abmeldefehler',
          landing_no_modules_title: 'Keine Module verfügbar',
          landing_no_modules_description:
            'Dein Konto hat derzeit keine aktivierten Module.',
          landing_select_title: 'Modul auswählen',
          landing_select_description: 'Wähle aus, wo du fortfahren möchtest.',
          landing_module_devices: 'Geräte',
          landing_module_locations: 'Standorte',
          landing_module_measurements: 'Messungen',
          landing_module_imei: 'IMEI-Anzeige',
          landing_module_backup: 'Backup',
          landing_module_docker: 'Docker-Status',
          landing_module_admin: 'Admin-Panel',
          measurement_compare_deviation_label: 'Abweichung (±1σ)',
          measurement_compare_deviation_lower_bound_label:
            'Untere Abweichungsgrenze',
          measurement_compare_pair_label: 'Paar',
          measurement_compare_range_label: 'Bereich',
          measurement_compare_mean_label: 'Mittelwert',
          measurement_compare_sigma_label: 'σ',
          measurement_compare_pair_sum_label: 'Paar-Summe',
          measurement_compare_sum_label: 'Summe',
          measurement_compare_samples_label: 'Stichproben',
          measurement_compare_measurement_datetime_label: 'Messungszeitpunkt',
          measurement_compare_measurements_included: 'Enthaltene Messungen',
          measurement_compare_avg_sigma_label: 'Durchschn. σ',
          measurement_compare_mean_avg_sigma_summary:
            'Mittelwert: {{mean}} | Durchschn. σ: {{avgSigma}}',
          measurement_compare_pair_index_axis: 'Paarindex',
          measurement_compare_absolute_delta_axis: 'Absolutes Delta',
          measurement_compare_pair_sum_axis: 'Paar-Summe',
        },
      },
    },
  });

// Register the custom formatter after i18next services are available.
const addDateHugeFormatter = () => {
  if (!i18n.services?.formatter) {
    return;
  }

  i18n.services.formatter.add('DATE_HUGE', (value, lng) => {
    return DateTime.fromJSDate(value)
      .setLocale(lng)
      .toLocaleString(DateTime.DATE_HUGE);
  });
};

if (i18n.isInitialized) {
  addDateHugeFormatter();
} else {
  i18n.on('initialized', addDateHugeFormatter);
}

export default i18n;
