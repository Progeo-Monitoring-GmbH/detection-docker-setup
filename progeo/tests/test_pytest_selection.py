from pathlib import Path

import pytest

from progeo.tests.pytest_selection import _MODULE_AREAS, AREA_MODULES

pytest_plugins = ("pytester",)


@pytest.fixture
def selection_project(pytester, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    pytester.makeconftest(
        f"import sys\nsys.path.insert(0, {str(root)!r})\n"
        'pytest_plugins = ("progeo.tests.pytest_selection",)\n'
    )
    pytester.makeini("""
        [pytest]
        markers =
            depends_on(*nodeids): upstream tests
            alarms: alarm tests
            http_client: test client
    """)
    return pytester


def test_every_test_module_has_one_registered_area():
    module_names = [f"test_{name}.py" for names in AREA_MODULES.values() for name in names.split()]
    test_files = {path.name for path in Path(__file__).parent.glob("test_*.py")}

    assert len(module_names) == len(set(module_names))
    assert set(module_names) == test_files, (
        f"Unregistered test modules: {sorted(test_files - set(module_names))}; "
        f"registered modules missing from disk: {sorted(set(module_names) - test_files)}"
    )
    assert set(_MODULE_AREAS) == test_files


def test_image_root_pytest_configuration_initializes_django_before_conftest(pytester, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    monkeypatch.delenv("DJANGO_SETTINGS_MODULE", raising=False)
    monkeypatch.syspath_prepend(str(root))
    monkeypatch.setenv("PYTHONPATH", str(root))
    pytester.path.joinpath("setup.cfg").write_text(
        root.joinpath("setup.cfg").read_text(encoding="utf-8"), encoding="utf-8"
    )
    pytester.makeconftest(root.joinpath("conftest.py").read_text(encoding="utf-8"))
    pytester.makepyfile(smoke_settings="""
        SECRET_KEY = "test"
        INSTALLED_APPS = ["django.contrib.auth", "django.contrib.contenttypes"]
        DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
        DEMO_DATABASE = "demo"
    """, test_smoke="""
        from django.apps import apps

        def test_apps_ready():
            assert apps.ready
    """)
    pytester.path.joinpath("progeo", "tests").mkdir(parents=True)

    result = pytester.runpytest_subprocess(
        "-p", "django", "-p", "pytest_cov", "-p", "pytest_html.plugin", "-p", "pytest_metadata.plugin",
        "--ds=smoke_settings", "--collect-only", "-q", "test_smoke.py",
    )

    assert result.ret == pytest.ExitCode.OK
    result.stdout.fnmatch_lines(["*test_smoke.py::test_apps_ready*", "*1 test collected*"])


def test_marker_selection_uses_area_and_client_fixture(selection_project):
    selection_project.makepyfile(test_alarm_overview_api="""
        import pytest

        @pytest.fixture
        def api_client():
            return object()

        def test_api(api_client):
            pass

        def test_other():
            pass
    """)

    result = selection_project.runpytest_subprocess("-q", "-m", "alarms and http_client")

    result.assert_outcomes(passed=1, deselected=1)


def test_reruns_cached_failures_and_transitive_downstream_only(selection_project):
    selection_project.makepyfile(test_flow="""
        import pathlib
        import pytest

        def record(name):
            with pathlib.Path("ran.txt").open("a") as out:
                out.write(name + "\\n")

        def test_failed():
            record("failed")
            assert pathlib.Path("fixed").exists()

        @pytest.mark.depends_on("test_flow.py::test_failed")
        def test_downstream():
            record("downstream")

        @pytest.mark.depends_on("test_flow.py::test_downstream")
        def test_transitive():
            record("transitive")

        def test_unrelated():
            record("unrelated")
    """)
    first = selection_project.runpytest_subprocess("-q")
    first.assert_outcomes(failed=1, passed=3)
    selection_project.path.joinpath("fixed").touch()
    selection_project.path.joinpath("ran.txt").unlink()

    second = selection_project.runpytest_subprocess("-q", "--failed-dependents")

    second.assert_outcomes(passed=3, deselected=1)
    assert selection_project.path.joinpath("ran.txt").read_text().splitlines() == [
        "failed", "downstream", "transitive"
    ]


def test_failed_dependents_reports_missing_cache(selection_project):
    selection_project.makepyfile("def test_example(): pass")

    result = selection_project.runpytest_subprocess("--failed-dependents")

    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.stderr.fnmatch_lines(["*no cached failures*"])


def test_failed_dependents_rejects_invalid_dependency_marker(selection_project):
    selection_project.makepyfile(test_flow="""
        import pytest

        @pytest.mark.depends_on()
        def test_bad():
            assert False
    """)
    selection_project.runpytest_subprocess("-q").assert_outcomes(failed=1)

    result = selection_project.runpytest_subprocess("--failed-dependents")

    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.stderr.fnmatch_lines(["*depends_on requires*"])


def test_failed_dependents_includes_tests_in_a_previously_uncollectable_file(selection_project):
    test_file = selection_project.makepyfile(test_flow="raise RuntimeError('collection failed')")
    first = selection_project.runpytest_subprocess("-q")
    first.assert_outcomes(errors=1)
    test_file.write_text("def test_recovered(): pass\n", encoding="utf-8")

    second = selection_project.runpytest_subprocess("-q", "--failed-dependents")

    second.assert_outcomes(passed=1)


def test_failed_dependents_can_be_narrowed_by_marker(selection_project):
    selection_project.makepyfile(test_flow="""
        import pathlib
        import pytest

        def test_failed():
            assert pathlib.Path("fixed").exists()

        @pytest.mark.alarms
        @pytest.mark.depends_on("test_flow.py::test_failed")
        def test_dependent():
            pass

        def test_unrelated():
            pass
    """)
    selection_project.runpytest_subprocess("-q").assert_outcomes(failed=1, passed=2)
    selection_project.path.joinpath("fixed").touch()

    result = selection_project.runpytest_subprocess("-q", "--failed-dependents", "-m", "alarms")

    result.assert_outcomes(passed=1, deselected=2)


def test_failed_dependents_supports_setup_failures_and_parametrized_nodeids(selection_project):
    selection_project.makepyfile(test_flow="""
        import pathlib
        import pytest

        @pytest.fixture
        def sometimes_fails():
            assert pathlib.Path("fixed").exists()

        @pytest.mark.parametrize("case", ["first", "second"])
        def test_root(case, sometimes_fails):
            pass

        @pytest.mark.depends_on("test_flow.py::test_root[first]")
        def test_dependent():
            pass

        def test_unrelated():
            pass
    """)
    selection_project.runpytest_subprocess("-q").assert_outcomes(errors=2, passed=2)
    selection_project.path.joinpath("fixed").touch()

    result = selection_project.runpytest_subprocess("-q", "--failed-dependents")

    result.assert_outcomes(passed=3, deselected=1)


def test_failed_dependents_rejects_last_failed_mode(selection_project):
    selection_project.makepyfile("def test_example(): pass")

    result = selection_project.runpytest_subprocess("--failed-dependents", "--lf")

    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.stderr.fnmatch_lines(["*cannot be combined with --lf or --ff*"])
