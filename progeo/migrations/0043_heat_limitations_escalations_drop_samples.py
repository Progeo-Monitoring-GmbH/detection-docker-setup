import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models

# Before ProgeoMeasurement.samples / end_index go, their data moves (every
# database - default and each project database run this migration):
#
# 1. Legacy pair rows (end_index > 0, no lists yet): the samples cut to the
#    declared m_points pairs and to an even length - like the split did
#    (project_db_copy.legacy_pairs_sql) - into eigenpotenzial / wirkpotenzial.
#    The jsonb cast only ever sees text that looks like an array (CASE).
# 2. Every other row still holding samples (IMEI resistances, pair rows
#    without m_points): the samples into raw_data["samples"], where
#    get_sample_values / get_resistance_vdc read them.
SAMPLES_TO_POTENTIALS = r"""
UPDATE progeo_progeomeasurement m
SET eigenpotenzial = p.eigen, wirkpotenzial = p.wirk
FROM (
    SELECT s.id,
           array_agg(round((t.e #>> '{}')::numeric)::integer ORDER BY t.o) FILTER (WHERE t.o % 2 = 1) AS eigen,
           array_agg(round((t.e #>> '{}')::numeric)::integer ORDER BY t.o) FILTER (WHERE t.o % 2 = 0) AS wirk
    FROM (
        SELECT id, end_index,
               CASE WHEN samples ~ '^\[.*\]$' THEN samples::jsonb ELSE '[]'::jsonb END AS j
        FROM progeo_progeomeasurement
        WHERE eigenpotenzial IS NULL AND end_index > 0 AND samples IS NOT NULL
        OFFSET 0
    ) s
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.j) = 'array' THEN s.j ELSE '[]'::jsonb END)
        WITH ORDINALITY t(e, o)
    WHERE t.o <= LEAST(2 * s.end_index, jsonb_array_length(s.j) / 2 * 2)
    GROUP BY s.id
) p
WHERE m.id = p.id
"""

SAMPLES_TO_RAW_DATA = r"""
UPDATE progeo_progeomeasurement
SET raw_data = (
    CASE WHEN raw_data ~ '^\s*\{.*\}\s*$' THEN raw_data::jsonb ELSE '{}'::jsonb END
    || jsonb_build_object(
        'samples',
        CASE WHEN samples ~ '^\[.*\]$' THEN samples::jsonb ELSE to_jsonb(btrim(samples, '"')) END
    )
)::text
WHERE eigenpotenzial IS NULL AND samples IS NOT NULL AND samples NOT IN ('', 'null', '[]', '""')
"""


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0042_progeodevice_commands'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Heat limitations of the Lageplan (areas the heat field is limited to).
        migrations.AddField(
            model_name='progeolageplan',
            name='heat_limitations',
            field=models.JSONField(blank=True, default=list),
        ),

        # The outdated samples column (and the legacy end_index with it).
        migrations.RunSQL(SAMPLES_TO_POTENTIALS, reverse_sql=migrations.RunSQL.noop),
        migrations.RunSQL(SAMPLES_TO_RAW_DATA, reverse_sql=migrations.RunSQL.noop),
        migrations.RemoveField(
            model_name='progeomeasurement',
            name='samples',
        ),
        migrations.RemoveField(
            model_name='progeomeasurement',
            name='end_index',
        ),

        # Escalations of a project and their protocol.
        migrations.CreateModel(
            name='ProgeoEscalation',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('project_id', models.IntegerField(blank=True, db_index=True, null=True)),
                ('title', models.CharField(max_length=200)),
                ('status', models.CharField(choices=[('open', 'Offen'), ('in_progress', 'In Bearbeitung'), ('waiting', 'Wartet auf Rückmeldung'), ('closed', 'Geschlossen')], db_index=True, default='open', max_length=16)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('updated', models.DateTimeField(default=django.utils.timezone.now)),
                ('closed_at', models.DateTimeField(blank=True, null=True)),
                ('assigned_to', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('closed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='escalations', to='progeo.progeolocation')),
            ],
            options={
                'ordering': ['-created'],
                'constraints': [
                    models.UniqueConstraint(condition=models.Q(('status', 'closed'), _negated=True), fields=('project_id',), name='progeo_escalation_one_open_per_project'),
                    models.UniqueConstraint(condition=models.Q(('status', 'closed'), _negated=True), fields=('location',), name='progeo_escalation_one_open_per_location'),
                ],
            },
        ),
        migrations.CreateModel(
            name='ProgeoEscalationEntry',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('kind', models.CharField(choices=[('created', 'Erstellt'), ('comment', 'Kommentar'), ('status', 'Status'), ('assigned', 'Zuweisung'), ('closed', 'Geschlossen')], default='comment', max_length=16)),
                ('text', models.TextField(blank=True, default='')),
                ('data', models.JSONField(blank=True, default=dict)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('author', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('escalation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='entries', to='progeo.progeoescalation')),
            ],
            options={
                'ordering': ['created', 'id'],
            },
        ),

        # Favorite locations of staff users (the favorites bar).
        migrations.CreateModel(
            name='ProgeoFavoriteLocation',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='progeo.progeolocation')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['created', 'id'],
                'constraints': [models.UniqueConstraint(fields=('user', 'location'), name='progeo_favorite_user_location')],
            },
        ),
    ]
