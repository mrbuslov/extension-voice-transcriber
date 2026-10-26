FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --system whisper && mkdir /models && chown whisper /models
USER whisper
WORKDIR /app
COPY server.py ./
VOLUME /models

CMD ["python", "server.py"]
