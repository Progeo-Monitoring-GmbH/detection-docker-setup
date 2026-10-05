"""Heatmap video export: the frames ZIP upload, the celery task's ffmpeg
rendering (helper/heatmap_video.py) and the result polling endpoint. Jobs
are written to tmp_path; the ffmpeg test is skipped without ffmpeg on PATH.
"""
import io
import os
import shutil
import time
import zipfile

import cv2
import numpy as np
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from progeo.helper import heatmap_video
from progeo.tests import factories as f
from progeo.v1.viewsets import locations_viewset

PERMS = ("module_locations_enabled", "module_measurements_enabled")


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(heatmap_video, "JOBS_DIR", str(tmp_path / "export" / "heatmap_videos"))
    monkeypatch.setattr(heatmap_video, "MEDIA_ROOT", str(tmp_path))
    return tmp_path


def _png(width, height, value):
    ok, data = cv2.imencode(".png", np.full((height, width, 3), value, np.uint8))
    assert ok
    return data.tobytes()


def _frames_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _upload(data, name="frames.zip"):
    return SimpleUploadedFile(name, data, content_type="application/zip")


def _job(entries):
    return heatmap_video.create_job(_upload(_frames_zip(entries)))


# -- rendering ------------------------------------------------------------


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_render_job_builds_zip_with_frames_and_video_from_odd_sized_frames(jobs_dir):
    # 973x333 is the odd plot size that broke the old make_video.bat.
    job_id = _job({f"frames/frame_{i:04d}.png": _png(973, 333, 40 * i) for i in range(1, 4)})

    path = heatmap_video.render_job(job_id)

    assert path == f"export/heatmap_videos/{job_id}/sensor-heatmap.zip"
    with zipfile.ZipFile(jobs_dir / path) as result:
        assert sorted(result.namelist()) == [
            "frames/frame_0001.png", "frames/frame_0002.png", "frames/frame_0003.png", "sensor-heatmap.mp4",
        ]
        assert result.getinfo("sensor-heatmap.mp4").file_size > 0
    assert not os.path.exists(os.path.join(heatmap_video.job_dir(job_id), "frames.zip"))


def test_render_job_ignores_foreign_entries_and_renumbers_frames(jobs_dir, monkeypatch):
    captured = {}

    def fake_ffmpeg(frames_dir, video_path, framerate):
        captured["frames"] = sorted(os.listdir(frames_dir))
        captured["framerate"] = framerate
        open(video_path, "wb").close()

    monkeypatch.setattr(heatmap_video, "_run_ffmpeg", fake_ffmpeg)
    job_id = _job({
        "frames/frame_0007.png": _png(4, 4, 1),
        "frames/frame_0003.png": _png(4, 4, 2),
        "../evil.png": b"x",
        "frames/notes.txt": b"x",
    })

    path = heatmap_video.render_job(job_id, framerate=500)

    assert captured == {"frames": ["frame_0001.png", "frame_0002.png"], "framerate": 60}
    with zipfile.ZipFile(jobs_dir / path) as result:
        assert sorted(result.namelist()) == ["frames/frame_0001.png", "frames/frame_0002.png", "sensor-heatmap.mp4"]
        # Frame order follows the uploaded numbering (0003 before 0007).
        assert result.read("frames/frame_0001.png") == _png(4, 4, 2)
    assert not (jobs_dir / "evil.png").exists()


@pytest.mark.parametrize("data, message", [
    (b"not a zip", "not a ZIP"),
    (_frames_zip({"other.txt": b"x"}), "no frames"),
])
def test_render_job_rejects_bad_uploads(jobs_dir, data, message):
    job_id = heatmap_video.create_job(_upload(data))
    with pytest.raises(heatmap_video.HeatmapVideoError, match=message):
        heatmap_video.render_job(job_id)


def test_render_job_reports_missing_ffmpeg(jobs_dir, monkeypatch):
    monkeypatch.setattr(heatmap_video, "ffmpeg_binary", lambda: "definitely-not-ffmpeg-xyz")
    job_id = _job({"frames/frame_0001.png": _png(4, 4, 1)})
    with pytest.raises(heatmap_video.HeatmapVideoError, match="not installed"):
        heatmap_video.render_job(job_id)


def test_job_dir_rejects_path_like_ids(jobs_dir):
    with pytest.raises(heatmap_video.HeatmapVideoError):
        heatmap_video.job_dir("../../etc")


def test_create_job_removes_expired_jobs(jobs_dir):
    old = _job({"frames/frame_0001.png": b"x"})
    old_dir = heatmap_video.job_dir(old)
    expired = time.time() - heatmap_video.JOB_RETENTION_SECONDS - 60
    os.utime(old_dir, (expired, expired))

    new = _job({"frames/frame_0001.png": b"x"})

    assert not os.path.exists(old_dir)
    assert os.path.isdir(heatmap_video.job_dir(new))


# -- API --------------------------------------------------------------------


class _FakeTask:
    id = "task-123"


class _FakeResult:
    def __init__(self, state, result=None):
        self.state = state
        self.result = result

    def ready(self):
        return self.state in ("SUCCESS", "FAILURE")

    def successful(self):
        return self.state == "SUCCESS"


@pytest.fixture
def client_with_perms(api_client):
    api_client.force_authenticate(user=f.make_user(perms=PERMS))
    return api_client


def test_start_heatmap_video_stores_frames_and_queues_task(client_with_perms, jobs_dir, monkeypatch):
    queued = []
    monkeypatch.setattr(locations_viewset.render_heatmap_video, "delay",
                        lambda *args: queued.append(args) or _FakeTask())
    data = _frames_zip({"frames/frame_0001.png": _png(4, 4, 1)})

    body = client_with_perms.post(
        "/v1/location/heatmap_video/", {"frames": _upload(data), "framerate": "12"}, format="multipart",
    ).json()

    assert body == {"task_id": "task-123", "success": True}
    [(job_id, framerate)] = queued
    assert framerate == 12
    with open(os.path.join(heatmap_video.job_dir(job_id), "frames.zip"), "rb") as fh:
        assert fh.read() == data


def test_start_heatmap_video_requires_frames(client_with_perms, jobs_dir):
    body = client_with_perms.post("/v1/location/heatmap_video/", {}, format="multipart").json()
    assert body["success"] is False
    assert body["reason"] == "Missing file: frames"


def test_start_heatmap_video_requires_permissions(api_client, jobs_dir):
    api_client.force_authenticate(user=f.make_user(perms=("module_locations_enabled",)))
    data = _frames_zip({"frames/frame_0001.png": b"x"})
    response = api_client.post("/v1/location/heatmap_video/", {"frames": _upload(data)}, format="multipart")
    assert response.status_code == 403


@pytest.mark.parametrize("state, result, expected", [
    ("PENDING", None, {"ready": False}),
    ("SUCCESS", {"path": "export/heatmap_videos/abc/sensor-heatmap.zip"},
     {"ready": True, "url": "media/export/heatmap_videos/abc/sensor-heatmap.zip"}),
    ("FAILURE", heatmap_video.HeatmapVideoError("ffmpeg failed: boom"),
     {"ready": True, "error": "ffmpeg failed: boom"}),
])
def test_heatmap_video_result_reports_task_state(client_with_perms, monkeypatch, state, result, expected):
    monkeypatch.setattr(locations_viewset, "AsyncResult", lambda task_id: _FakeResult(state, result))

    body = client_with_perms.get("/v1/location/heatmap_video_result/", {"task_id": "task-123"}).json()

    assert body == {"task_id": "task-123", "state": state, "success": True, **expected}
