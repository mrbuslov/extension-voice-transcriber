"""Local speech-to-text: POST /transcribe[?language=xx] with raw audio bytes returns {"text", "segments", "language", "duration_s", "elapsed_s"}.
GET /health is 200 once the model is loaded, 503 {"state": "downloading" | "loading"} before that, 500 {"state": "failed"} if loading failed."""

import io
import json
import logging
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from faster_whisper import WhisperModel
from huggingface_hub.errors import LocalEntryNotFoundError

PORT = 9000
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # matches the OpenAI upload limit the extension already chunks for

logger = logging.getLogger("whisper")


class Speech:
    def __init__(self, model_name: str, cpu_threads: int):
        self._model_name = model_name
        self._cpu_threads = cpu_threads
        self._model: WhisperModel | None = None
        self.state = "loading"
        self.error: str | None = None
        # one transcription at a time keeps the CPU load bounded by cpu_threads
        self._lock = threading.Lock()

    def load(self) -> None:
        try:
            self._model = self._load_model()
        except Exception as e:  # runs on a background thread: anything uncaught would leave /health stuck at "loading"
            logger.exception("Model load failed")
            self.state, self.error = "failed", f"{type(e).__name__}: {e}"
            return
        self.state = "ready"
        logger.info(f"Model {self._model_name} loaded")

    def _load_model(self) -> WhisperModel:
        try:
            # A cached model loads offline: no Hub revision check, and it works without internet
            return self._open(local_files_only=True)
        except LocalEntryNotFoundError:
            self.state = "downloading"
            logger.info(f"Model {self._model_name} is not cached, downloading")
            return self._open(local_files_only=False)

    def _open(self, *, local_files_only: bool) -> WhisperModel:
        return WhisperModel(
            self._model_name, device="cpu", compute_type="int8", cpu_threads=self._cpu_threads,
            download_root="/models", local_files_only=local_files_only,
        )

    def transcribe(self, audio: bytes, language: str | None) -> dict:
        started = time.monotonic()
        with self._lock:
            # VAD stops hallucinations on silence; the default 400ms pad clipped short phrases at chunk starts
            segments, info = self._model.transcribe(io.BytesIO(audio), language=language, vad_filter=True, vad_parameters={"speech_pad_ms": 1000})
            segments = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
        return {
            "text": " ".join(s["text"] for s in segments).strip(),
            "segments": segments,
            "language": info.language,
            "duration_s": round(info.duration, 1),
            "elapsed_s": round(time.monotonic() - started, 1),
        }


def make_handler(speech: Speech):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if urlparse(self.path).path != "/health":
                self._send_error(HTTPStatus.NOT_FOUND, f"Unknown path {self.path}")
                return
            if speech.state == "failed":
                self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"state": speech.state, "error": {"message": speech.error}})
                return
            status = HTTPStatus.OK if speech.state == "ready" else HTTPStatus.SERVICE_UNAVAILABLE
            self._send(status, {"state": speech.state})

        def do_POST(self):
            url = urlparse(self.path)
            if url.path != "/transcribe":
                self._send_error(HTTPStatus.NOT_FOUND, f"Unknown path {self.path}")
                return
            if speech.state != "ready":
                self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, f"Model is {speech.state}, poll /health until it is ready")
                return
            length = self.headers["Content-Length"]
            if length is None or not 0 < int(length) <= MAX_AUDIO_BYTES:
                self._send_error(HTTPStatus.BAD_REQUEST, f"Body must be 1..{MAX_AUDIO_BYTES} bytes of audio, Content-Length {length!r}")
                return
            language = parse_qs(url.query).get("language", [None])[0]
            try:
                result = speech.transcribe(self.rfile.read(int(length)), language)
            except Exception as e:  # undecodable audio arrives as many PyAV/ctranslate2 error types; the caller gets the reason
                logger.exception("Transcription failed")
                self._send_error(HTTPStatus.UNPROCESSABLE_ENTITY, f"{type(e).__name__}: {e}")
                return
            logger.info(f"Transcribed {result['duration_s']}s of {result['language']} in {result['elapsed_s']}s")
            self._send(HTTPStatus.OK, result)

        def _send_error(self, status: HTTPStatus, message: str) -> None:
            self._send(status, {"error": {"message": message}})

        def _send(self, status: HTTPStatus, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format, *args):
            logger.info(f"{self.address_string()} {format % args}")

    return Handler


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    speech = Speech(os.environ["WHISPER_MODEL"], int(os.environ["WHISPER_CPU_THREADS"]))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), make_handler(speech))
    # Listen first so /health can report download and load progress instead of refusing connections
    threading.Thread(target=speech.load, daemon=True).start()
    logger.info(f"Listening on :{PORT}, loading model {os.environ['WHISPER_MODEL']}")
    server.serve_forever()


if __name__ == "__main__":
    main()
