"""Escalations of a project: /v1/escalation/ - opened by staff, worked on
by staff (comments, status, assignment, closing), everything protocolled."""
import pytest

from progeo.tests import factories as f
from progeo.v1.models import ProgeoEscalation, ProgeoEscalationEntry

URL = "/v1/escalation/"


@pytest.fixture
def world(api_client):
    account = f.make_account()
    location = f.make_location(account, project_id=4711, name="Halle Nord")
    superuser = f.make_user(is_superuser=True)
    staff = f.make_user(staff=True, first_name="Stefanie", last_name="Staff")
    api_client.force_authenticate(user=superuser)
    return {"account": account, "location": location, "superuser": superuser, "staff": staff}


def _open(api_client, location, **fields):
    response = api_client.post(URL, {"location": location.pk, "title": "Leckage", **fields}, format="json")
    assert response.status_code == 200, response.content
    return response.json()["escalation"]


def _kinds(escalation_id):
    return list(
        ProgeoEscalationEntry.objects.using(f.DB).filter(escalation_id=escalation_id).values_list("kind", flat=True)
    )


def test_superuser_opens_an_escalation_with_its_protocol(api_client, world):
    escalation = _open(api_client, world["location"], text="Wasser im Keller", assigned_to=world["staff"].pk)

    assert escalation["project_id"] == 4711
    assert escalation["location_name"] == "Halle Nord"
    assert escalation["status"] == "open"
    assert escalation["assigned_to_name"] == "Stefanie Staff"
    assert [(entry["kind"], entry["text"]) for entry in escalation["entries"]] == [
        ("created", "Wasser im Keller"), ("assigned", ""),
    ]


def test_one_open_escalation_per_project(api_client, world):
    first = _open(api_client, world["location"])
    # Another location of the same project.
    sibling = f.make_location(world["account"], project_id=4711)

    response = api_client.post(URL, {"location": sibling.pk, "title": "Noch eine"}, format="json")

    assert response.status_code == 400
    assert response.json()["id"] == first["id"]
    # Once closed, the project can be escalated again.
    api_client.post(f"{URL}{first['id']}/close/", {}, format="json")
    _open(api_client, sibling)


def test_staff_opens_and_works_on_escalations(api_client, world):
    escalation = _open(api_client, world["location"])
    api_client.force_authenticate(user=world["staff"])

    # Another project, so the one open escalation rule does not interfere.
    other = f.make_location(world["account"], project_id=4713)
    opened = api_client.post(URL, {"location": other.pk, "title": "x"}, format="json")
    assert opened.status_code == 200, opened.content

    base = f"{URL}{escalation['id']}/"
    assert api_client.post(f"{base}comment/", {"text": "Bin vor Ort"}, format="json").status_code == 200
    assert api_client.post(f"{base}status/", {"status": "in_progress", "text": "Pumpe läuft"},
                           format="json").status_code == 200
    assert api_client.post(f"{base}assign/", {"assigned_to": world["staff"].pk}, format="json").status_code == 200
    closed = api_client.post(f"{base}close/", {"text": "Behoben"}, format="json")

    assert closed.status_code == 200, closed.content
    body = closed.json()["escalation"]
    assert body["status"] == "closed"
    assert body["closed_by"] == world["staff"].pk
    assert body["closed_at"] is not None
    assert _kinds(escalation["id"]) == ["created", "comment", "status", "assigned", "closed"]
    status_entry = ProgeoEscalationEntry.objects.using(f.DB).get(escalation_id=escalation["id"], kind="status")
    assert status_entry.data == {"from": "open", "to": "in_progress"}
    assert status_entry.text == "Pumpe läuft"
    assert status_entry.author_id == world["staff"].pk


def test_a_closed_escalation_takes_no_more_changes(api_client, world):
    escalation = _open(api_client, world["location"])
    api_client.post(f"{URL}{escalation['id']}/close/", {}, format="json")

    response = api_client.post(f"{URL}{escalation['id']}/comment/", {"text": "zu spät"}, format="json")

    assert response.status_code == 400
    assert _kinds(escalation["id"]) == ["created", "closed"]


@pytest.mark.parametrize(
    ("action", "data"),
    [
        ("comment", {"text": "   "}),
        ("status", {"status": "closed"}),  # closing is its own action
        ("status", {"status": "open"}),  # unchanged
        ("status", {"status": "nonsense"}),
        ("assign", {"assigned_to": None}),  # unchanged
    ],
)
def test_invalid_changes_are_refused_and_not_protocolled(api_client, world, action, data):
    escalation = _open(api_client, world["location"])

    response = api_client.post(f"{URL}{escalation['id']}/{action}/", data, format="json")

    assert response.status_code == 400
    assert _kinds(escalation["id"]) == ["created"]


def test_only_staff_users_can_be_assigned(api_client, world):
    escalation = _open(api_client, world["location"])
    customer = f.make_user()

    response = api_client.post(f"{URL}{escalation['id']}/assign/", {"assigned_to": customer.pk}, format="json")

    assert response.status_code == 400
    staff_ids = [user["id"] for user in api_client.get(f"{URL}staff/").json()["users"]]
    assert world["staff"].pk in staff_ids and world["superuser"].pk in staff_ids
    assert customer.pk not in staff_ids


def test_the_list_filters_by_state_and_project(api_client, world):
    open_one = _open(api_client, world["location"])
    other = f.make_location(world["account"], project_id=4712)
    closed_one = _open(api_client, other)
    api_client.post(f"{URL}{closed_one['id']}/close/", {}, format="json")

    def ids(query=""):
        return [row["id"] for row in api_client.get(f"{URL}{query}").json()["escalations"]]

    assert set(ids()) >= {open_one["id"], closed_one["id"]}
    assert open_one["id"] in ids("?state=open") and closed_one["id"] not in ids("?state=open")
    assert ids(f"?location={world['location'].pk}") == [open_one["id"]]
    entry_counts = {row["id"]: row["entry_count"] for row in api_client.get(URL).json()["escalations"]}
    assert entry_counts[closed_one["id"]] == 2


def test_customers_see_no_escalations(api_client, world):
    _open(api_client, world["location"])
    api_client.force_authenticate(user=f.make_user(accounts=[world["account"]]))

    assert api_client.get(URL).status_code == 403
    assert ProgeoEscalation.objects.using(f.DB).count() >= 1
