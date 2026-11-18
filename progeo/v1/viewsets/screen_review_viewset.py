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
from progeo.helper import screen_review as review
from progeo.helper.basics import RequestSuccess
from progeo.helper.location_access import is_staff_admin
from progeo.v1.models import ScreenReviewMark, ScreenReviewNote


def _failed(reason, status=400):
    return Response({"success": False, "reason": reason}, status=status)


class ScreenReviewViewSet(viewsets.ViewSet):
    """The screenshots of the e2e_screenshots runs and their review comments
    (helper/screen_review.py) - staff only:

        GET    /v1/screen-review/                              the runs, newest first
        GET    /v1/screen-review/<run>/                        its images, notes and reviewed marks
        DELETE /v1/screen-review/<run>/                        the run with its notes (superusers)
        GET    /v1/screen-review/<run>/image/<file>/           a screenshot (PNG)
        GET    /v1/screen-review/<run>/export/                 ZIP: PROMPT.md, notes.json, screens/
        POST   /v1/screen-review/<run>/notes/                  {image, kind, action, comment, geometry}
        PATCH  /v1/screen-review/<run>/notes/<id>/             the same fields
        DELETE /v1/screen-review/<run>/notes/<id>/
        POST   /v1/screen-review/<run>/reviewed/               {image, reviewed: true|false}
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]
    lookup_field = "run"
    lookup_value_regex = r"\d{4}-\d{2}-\d{2}_\d{6}"

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self._staff = is_staff_admin(request.user)

    def _forbidden(self):
        return None if self._staff else _failed("staff only", 403)

    def list(self, request, *args, **kwargs):
        return self._forbidden() or RequestSuccess({"runs": review.list_runs()})

    def retrieve(self, request, run=None, *args, **kwargs):
        if (denied := self._forbidden()) is not None:
            return denied
        try:
            images = review.run_images(run)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        notes = ScreenReviewNote.objects.filter(run=run).select_related("author")
        marks = ScreenReviewMark.objects.filter(run=run).select_related("reviewed_by")
        return RequestSuccess({
            "run": run, "images": images, "notes": [review.note_payload(note) for note in notes],
            "reviewed": [review.mark_payload(mark) for mark in marks],
        })

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

    @action(detail=True, methods=["GET"], url_path=r"image/(?P<file>[A-Za-z0-9.\-]+)")
    def image(self, request, run=None, file=None, *args, **kwargs):
        if (denied := self._forbidden()) is not None:
            return denied
        try:
            path = review.image_path(run, file)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        response = FileResponse(path.open("rb"), content_type="image/png")
        # A run's screenshots never change.
        response["Cache-Control"] = "private, max-age=86400"
        return response

    @action(detail=True, methods=["GET"], url_path="export")
    def export(self, request, run=None, *args, **kwargs):
        if (denied := self._forbidden()) is not None:
            return denied
        try:
            content = review.export_zip(run)
        except review.ReviewError as exc:
            return _failed(str(exc), 404)
        response = HttpResponse(content, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="screen-review-{run}.zip"'
        return response

    @action(detail=True, methods=["POST"], url_path="notes")
    def notes(self, request, run=None, *args, **kwargs):
        if (denied := self._forbidden()) is not None:
            return denied
        try:
            fields = review.clean_note(request.data, run)
        except review.ReviewError as exc:
            return _failed(str(exc))
        note = ScreenReviewNote.objects.create(run=run, author=request.user, **fields)
        return RequestSuccess({"note": review.note_payload(note)})

    @action(detail=True, methods=["PATCH", "DELETE"], url_path=r"notes/(?P<note_id>\d+)")
    def note(self, request, run=None, note_id=None, *args, **kwargs):
        if (denied := self._forbidden()) is not None:
            return denied
        note = ScreenReviewNote.objects.filter(run=run, pk=int(note_id)).select_related("author").first()
        if note is None:
            return _failed("Note not found", 404)
        if request.method == "DELETE":
            note.delete()
            return RequestSuccess({"deleted": int(note_id)})
        data = request.data if isinstance(request.data, dict) else {}
        try:
            fields = review.clean_note({**review.note_payload(note), **data, "image": note.image}, run)
        except review.ReviewError as exc:
            return _failed(str(exc))
        for name, value in fields.items():
            setattr(note, name, value)
        note.updated = timezone.now()
        note.save()
        return RequestSuccess({"note": review.note_payload(note)})

    @action(detail=True, methods=["POST"], url_path="reviewed")
    def reviewed(self, request, run=None, *args, **kwargs):
        """A screenshot marked as reviewed (or not any more) - for the whole team."""
        if (denied := self._forbidden()) is not None:
            return denied
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
