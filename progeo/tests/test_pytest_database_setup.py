import pytest
from django.conf import settings
from django.db import connections

from conftest import TEST_DATABASES, pytest_collection_modifyitems


class Item:
    def __init__(self, marker=None):
        self.marker = marker

    def get_closest_marker(self, name):
        assert name == "django_db"
        return self.marker

    def add_marker(self, marker, append=True):
        self.marker = marker.mark


def test_collection_adds_isolated_default_and_demo_databases():
    item = Item()

    pytest_collection_modifyitems([item])

    assert item.marker.kwargs["databases"] == TEST_DATABASES


def test_collection_preserves_additional_databases_and_options():
    item = Item(pytest.mark.django_db(databases=["extra"], transaction=True).mark)

    pytest_collection_modifyitems([item])

    assert item.marker.kwargs["databases"] == [*TEST_DATABASES, "extra"]
    assert item.marker.kwargs["transaction"] is True


def test_collection_preserves_all_databases_marker():
    marker = pytest.mark.django_db(databases="__all__").mark
    item = Item(marker)

    pytest_collection_modifyitems([item])

    assert item.marker is marker


def test_demo_database_has_its_own_test_transaction():
    assert connections["default"] is connections["unit_tests"]
    assert connections[settings.DEMO_DATABASE] is not connections["default"]
    assert connections[settings.DEMO_DATABASE].in_atomic_block
    with connections[settings.DEMO_DATABASE].cursor() as cursor:
        cursor.execute("SELECT 1")
        assert cursor.fetchone() == (1,)
