import shutil

from django.http import FileResponse, HttpResponse
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import require_staff_permissions
from progeo.helper import screen_review as review
from progeo.helper.basics import RequestSuccess
from progeo.v1.models import ScreenReviewMark, ScreenReviewNote


def _failed(reason, status=400):
    return Response({"success": False, "reason": reason}, status=status)


class ScreenReviewViewSet(viewsets.ViewSet):
    """The screenshots of the e2e_screenshots runs and their review comments
    (helper/screen_review.py) - staff only:

        GET    /v1/screen-review/                              the runs, newest first
        GET    /v1/screen-review/<run>/                        its images, notes, reviewed marks and failures
        DELETE /v1/screen-review/<run>/                        the run with its notes (superusers)
        GET    /v1/screen-review/<run>/image/<file>/           a screenshot (PNG)
        GET    /v1/screen-review/<run>/export/                 ZIP: PROMPT.md, notes.json, screens/
        POST   /v1/screen-review/<run>/notes/                  {image, kind, action, comment, geometry, scope}
                                                               (a "general" note: image "", the whole run)
        PATCH  /v1/screen-review/<run>/notes/<id>/             the same fields and/or {done: true|false}
        DELETE /v1/screen-review/<run>/notes/<id>/
        POST   /v1/screen-review/<run>/reviewed/               {image, reviewed: true|false}
        GET    /v1/screen-review/fetch/                        the fetch from staging: {enabled, state}
        POST   /v1/screen-review/fetch/                        fetch the runs this server lacks (background)

    Without the screenshot container (COMPOSE_PROFILES without e2e_screens)
    the runs come from the staging server (helper/screen_review_fetch.py).
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]
    lookup_field = "run"
    # A capture's date stamp, or a folder made by hand (screen_review.RUN_NAME_RE).
    lookup_value_regex = r"[A-Za-z0-9][A-Za-z0-9_-]{0,31}"

    @require_staff_permissions("module_admin_screen_review")
    def list(self, request, *args, **kwargs):
        from progeo.helper import screen_review_fetch as fetch

        return RequestSuccess({
            "runs": review.list_runs(),
            # No screenshots of its own: the gallery offers "Fetch from staging".
            "can_capture": fetch.capture_available(),
            "can_fetch": fetch.fetch_enabled(),
        })

    @require_staff_permissions("module_admin_screen_review")
    @action(detail=False, methods=["GET", "POST"], url_path="fetch")
    def fetch(self, request, *args, **kwargs):
        """The runs from the staging server: GET the state of the last fetch,
        POST starts one in the background (one at a time)."""
        from progeo.helper import screen_review_fetch as fetch

        if request.method == "GET":
            return RequestSuccess({"enabled": fetch.fetch_enabled(), "state": fetch.state()})
        if not fetch.fetch_enabled():
            return _failed("This server takes its own screenshots or has no staging server (STAGING_REMOTE_HOST)",
                           409)
        if fetch.is_running():
            return RequestSuccess({"enabled": True, "state": fetch.state()})
        fetch.mark_queued()
        from progeo.tasks import fetch_screen_reviews_task

        try:
            fetch_screen_reviews_task.apply_async(retry=False)
        except Exception:  # noqa: BLE001 - no broker (local development): fetch right here
            fetch.run_fetch()
        return RequestSuccess({"enabled": True, "state": fetch.state()})

    @require_staff_permissions("module_admin_screen_review")
    def retrieve(self, request, run=None, *args, **kwargs):
        try:
            images = review.run_images(run)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        notes = ScreenReviewNote.objects.filter(run=run).select_related("author", "done_by")
        marks = ScreenReviewMark.objects.filter(run=run).select_related("reviewed_by")
        return RequestSuccess({
            "run": run, "images": images, "notes": [review.note_payload(note) for note in notes],
            "reviewed": [review.mark_payload(mark) for mark in marks],
            # The dialogs (and pages) the capture could not take - and why.
            "failures": review.run_failures(run),
        })

    @require_staff_permissions("module_admin_screen_review")
    def destroy(self, request, run=None, *args, **kwargs):
        if not getattr(request.user, "is_superuser", False):
            return _failed("Superuser access required", 403)
        try:
            folder = review.run_dir(run)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        ScreenReviewNote.objects.filter(run=run).delete()
        ScreenReviewMark.objects.filter(run=run).delete()
        shutil.rmtree(folder)
        return RequestSuccess({"deleted": run})

    @require_staff_permissions("module_admin_screen_review")
    @action(detail=True, methods=["GET"], url_path=r"image/(?P<file>[A-Za-z0-9._\-]+)")
    def image(self, request, run=None, file=None, *args, **kwargs):
        try:
            path = review.image_path(run, file)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        response = FileResponse(path.open("rb"), content_type="image/png")
        # A run's screenshots never change.
        response["Cache-Control"] = "private, max-age=86400"
        return response

    @require_staff_permissions("module_admin_screen_review")
    @action(detail=True, methods=["GET"], url_path="export")
    def export(self, request, run=None, *args, **kwargs):
        try:
            content = review.export_zip(run)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        response = HttpResponse(content, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="screen-review-{run}.zip"'
        return response

    @require_staff_permissions("module_admin_screen_review")
    @action(detail=True, methods=["POST"], url_path="notes")
    def notes(self, request, run=None, *args, **kwargs):
        try:
            fields = review.clean_note(request.data, run)
        except review.ReviewError as exc:
            return _failed(str(exc))
        note = ScreenReviewNote.objects.create(run=run, author=request.user, **fields)
        return RequestSuccess({"note": review.note_payload(note)})

    @require_staff_permissions("module_admin_screen_review")
    @action(detail=True, methods=["PATCH", "DELETE"], url_path=r"notes/(?P<note_id>\d+)")
    def note(self, request, run=None, note_id=None, *args, **kwargs):
        note = ScreenReviewNote.objects.filter(run=run, pk=int(note_id)).select_related("author", "done_by").first()
        if note is None:
            return _failed("Note not found", 404)
        if request.method == "DELETE":
            note.delete()
            return RequestSuccess({"deleted": int(note_id)})
        data = request.data if isinstance(request.data, dict) else {}
        if "done" in data and not isinstance(data["done"], bool):
            return _failed("done must be true or false")
        # Only {done}: no check of the other fields (an older note may lack
        # the comment a new one needs).
        if set(data) - {"done"}:
            try:
                fields = review.clean_note({**review.note_payload(note), **data, "image": note.image}, run)
            except review.ReviewError as exc:
                return _failed(str(exc))
            for name, value in fields.items():
                setattr(note, name, value)
        if "done" in data and data["done"] != (note.done_at is not None):
            note.done_at = timezone.now() if data["done"] else None
            note.done_by = request.user if data["done"] else None
        note.updated = timezone.now()
        note.save()
        return RequestSuccess({"note": review.note_payload(note)})

    @require_staff_permissions("module_admin_screen_review")
    @action(detail=True, methods=["POST"], url_path="reviewed")
    def reviewed(self, request, run=None, *args, **kwargs):
        """A screenshot marked as reviewed (or not any more) - for the whole team."""
        data = request.data if isinstance(request.data, dict) else {}
        image = data.get("image")
        try:
            review.image_path(run, image)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        if not isinstance(data.get("reviewed"), bool):
            return _failed("reviewed must be true or false")
        if not data["reviewed"]:
            ScreenReviewMark.objects.filter(run=run, image=image).delete()
            return RequestSuccess({"image": image, "reviewed": None})
        mark, _created = ScreenReviewMark.objects.get_or_create(
            run=run, image=image, defaults={"reviewed_by": request.user},
        )
        return RequestSuccess({"image": image, "reviewed": review.mark_payload(mark)})
