"""
Heatmap video export: the browser captures the heatmap animation as PNG
frames and uploads them as a ZIP; a celery task renders them into an MP4 with
ffmpeg and packs frames + video into the ZIP the user downloads. Users don't
need ffmpeg installed themselves.

Job layout (one directory per export, under EXPORT_DIR/heatmap_videos/):

    <job_id>/frames.zip           uploaded frames (deleted after rendering)
    <job_id>/sensor-heatmap.zip   result: frames/frame_NNNN.png + sensor-heatmap.mp4
"""
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import zipfile

from progeo.settings import EXPORT_DIR, MEDIA_ROOT

JOBS_DIR = os.path.join(EXPORT_DIR, "heatmap_videos")
FRAMES_ZIP_NAME = "frames.zip"
RESULT_ZIP_NAME = "sensor-heatmap.zip"
VIDEO_NAME = "sensor-heatmap.mp4"

# Frames as written by the frontend (useHeatmapFrameExport.ts); every other
# ZIP entry is ignored, so nothing outside the job directory is ever written.
FRAME_NAME_RE = re.compile(r"^frames/frame_(\d{4})\.png$")
MAX_FRAMES = 500
MAX_FRAME_BYTES = 20 * 1024 * 1024

FFMPEG_TIMEOUT_SECONDS = 300
# Finished jobs are kept this long so the user can download the result.
JOB_RETENTION_SECONDS = 24 * 60 * 60

_JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class HeatmapVideoError(Exception):
    pass


def ffmpeg_binary() -> str:
    return os.getenv("FFMPEG_BINARY") or shutil.which("ffmpeg") or "ffmpeg"


def job_dir(job_id: str) -> str:
    if not _JOB_ID_RE.match(job_id or ""):
        raise HeatmapVideoError(f"Invalid job id: {job_id!r}")
    return os.path.join(JOBS_DIR, job_id)


def create_job(frames_zip) -> str:
    """Store an uploaded frames ZIP (Django UploadedFile) in a new job
    directory and return the job id."""
    cleanup_old_jobs()
    job_id = uuid.uuid4().hex
    directory = job_dir(job_id)
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, FRAMES_ZIP_NAME), "wb") as fh:
        fh.writelines(frames_zip.chunks())
    return job_id


def cleanup_old_jobs(now: float | None = None) -> None:
    if not os.path.isdir(JOBS_DIR):
        return
    cutoff = (now or time.time()) - JOB_RETENTION_SECONDS
    for name in os.listdir(JOBS_DIR):
        path = os.path.join(JOBS_DIR, name)
        if _JOB_ID_RE.match(name) and os.path.isdir(path) and os.path.getmtime(path) < cutoff:
            shutil.rmtree(path, ignore_errors=True)


def _extract_frames(frames_zip_path: str, target_dir: str) -> list[str]:
    """Extract the frame PNGs (renumbered 1..n, in frame order) and return
    their paths."""
    try:
        archive = zipfile.ZipFile(frames_zip_path)
    except zipfile.BadZipFile as exc:
        raise HeatmapVideoError("The uploaded file is not a ZIP archive.") from exc

    with archive:
        entries = sorted(
            (int(match.group(1)), info)
            for info in archive.infolist()
            if (match := FRAME_NAME_RE.match(info.filename))
        )
        if not entries:
            raise HeatmapVideoError("The upload contains no frames.")
        if len(entries) > MAX_FRAMES:
            raise HeatmapVideoError(f"Too many frames ({len(entries)} > {MAX_FRAMES}).")

        paths = []
        for index, (_, info) in enumerate(entries, start=1):
            if info.file_size > MAX_FRAME_BYTES:
                raise HeatmapVideoError(f"Frame {info.filename} is too large.")
            path = os.path.join(target_dir, f"frame_{index:04d}.png")
            with archive.open(info) as source, open(path, "wb") as target:
                shutil.copyfileobj(source, target)
            paths.append(path)
        return paths


def _run_ffmpeg(frames_dir: str, video_path: str, framerate: int) -> None:
    command = [
        ffmpeg_binary(), "-y", "-loglevel", "error",
        "-framerate", str(framerate), "-thread_queue_size", "512",
        "-i", os.path.join(frames_dir, "frame_%04d.png"),
        # Frames have the plot's own size, which can be odd - libx264 with
        # yuv420p needs even dimensions, so pad by up to 1px (white).
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:white",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        video_path,
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    except FileNotFoundError as exc:
        raise HeatmapVideoError("ffmpeg is not installed on the server.") from exc
    except subprocess.TimeoutExpired as exc:
        raise HeatmapVideoError("ffmpeg took too long to render the video.") from exc
    if completed.returncode != 0 or not os.path.isfile(video_path):
        detail = (completed.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
        raise HeatmapVideoError(f"ffmpeg failed: {detail[0]}")


def render_job(job_id: str, framerate: int = 8) -> str:
    """Render a job's frames into an MP4 and build the result ZIP (frames +
    video). Returns the result's path relative to MEDIA_ROOT."""
    directory = job_dir(job_id)
    frames_zip_path = os.path.join(directory, FRAMES_ZIP_NAME)
    if not os.path.isfile(frames_zip_path):
        raise HeatmapVideoError("The uploaded frames are missing.")
    framerate = max(1, min(int(framerate), 60))

    with tempfile.TemporaryDirectory(dir=directory) as work_dir:
        frame_paths = _extract_frames(frames_zip_path, work_dir)
        video_path = os.path.join(work_dir, VIDEO_NAME)
        _run_ffmpeg(work_dir, video_path, framerate)

        result_path = os.path.join(directory, RESULT_ZIP_NAME)
        # PNG and MP4 are already compressed - store them as-is.
        with zipfile.ZipFile(result_path, "w", compression=zipfile.ZIP_STORED) as result:
            result.write(video_path, VIDEO_NAME)
            for path in frame_paths:
                result.write(path, f"frames/{os.path.basename(path)}")

    os.remove(frames_zip_path)
    return os.path.relpath(result_path, MEDIA_ROOT).replace(os.sep, "/")
