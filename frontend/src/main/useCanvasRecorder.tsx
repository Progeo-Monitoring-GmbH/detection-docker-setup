import * as React from 'react';

type UseCanvasRecorderOptions = {
  fps?: number; // default 30
  maxDurationMs?: number; // e.g. 40000 for 40 seconds (optional)
};

type UseCanvasRecorderReturn = {
  startRecording: () => void;
  stopRecording: () => void;
  isRecording: boolean;
  downloadUrl: string | null;
  isSupported: boolean;
  reset: () => void;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') {
    return undefined;
  }
  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }

  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=h264',
    'video/mp4',
  ];

  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }

  // Safari iOS: best to let the browser choose, so we return undefined
  return undefined;
}

export function useCanvasRecorder(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  options: UseCanvasRecorderOptions = {},
): UseCanvasRecorderReturn {
  const { fps = 30, maxDurationMs } = options;

  const [isRecording, setIsRecording] = React.useState(false);
  const [downloadUrl, setDownloadUrl] = React.useState<string | null>(null);
  const [isSupported] = React.useState(
    () => typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined',
  );

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<BlobPart[]>([]);
  const stopTimeoutRef = React.useRef<number | null>(null);

  // Clean up object URL on unmount or when changing recording
  React.useEffect(() => {
    return () => {
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.stop();
      }
      if (stopTimeoutRef.current !== null) {
        window.clearTimeout(stopTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = React.useCallback(() => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
    }
    setDownloadUrl(null);
  }, [downloadUrl]);

  const stopRecording = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
    if (stopTimeoutRef.current !== null) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
  }, []);

  const startRecording = React.useCallback(() => {
    if (!isSupported) {
      console.warn('MediaRecorder is not supported in this browser.');
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn('Canvas element not ready yet.');
      return;
    }

    if (isRecording) {
      console.warn('Already recording.');
      return;
    }

    // Clean previous download URL
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
    }
    setDownloadUrl(null);

    // Capture stream from canvas
    const stream = canvas.captureStream(fps);
    const mimeType = pickMimeType();
    const options: MediaRecorderOptions = mimeType ? { mimeType } : {};

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch (e) {
      console.error('Failed to create MediaRecorder:', e);
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];
    setIsRecording(true);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      setIsRecording(false);

      const finalMime = recorder.mimeType || mimeType || 'video/webm'; // fallback type

      const blob = new Blob(chunksRef.current, { type: finalMime });
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);

      // Clean timeout ref
      if (stopTimeoutRef.current !== null) {
        window.clearTimeout(stopTimeoutRef.current);
        stopTimeoutRef.current = null;
      }
    };

    recorder.onerror = (event) => {
      console.error('MediaRecorder error:', event);
      setIsRecording(false);
    };

    recorder.start(); // Start recording

    // Optional auto-stop (e.g. 40 seconds)
    if (maxDurationMs != null) {
      stopTimeoutRef.current = window.setTimeout(() => {
        stopRecording();
      }, maxDurationMs);
    }
  }, [
    canvasRef,
    downloadUrl,
    fps,
    isRecording,
    isSupported,
    maxDurationMs,
    stopRecording,
  ]);

  return {
    startRecording,
    stopRecording,
    isRecording,
    downloadUrl,
    isSupported,
    reset,
  };
}
