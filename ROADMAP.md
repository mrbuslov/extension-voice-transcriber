# Roadmap

## Docker provider: model picker

Today the Docker provider always runs Whisper `small` (`DOCKER_WHISPER.model` in `src/types/index.ts`). Let the user pick the model in Advanced Settings, the same way OpenRouter lists its transcription models.

Candidates (faster-whisper names, int8 on CPU):

| model | download | quality | speed vs small |
|---|---|---|---|
| `base` | ~150 MB | noticeably worse on Russian/Ukrainian | ~2-3x faster |
| `small` | ~500 MB | current default | 1x |
| `medium` | ~1.5 GB | better on accents and noisy calls | ~2-3x slower |
| `large-v3-turbo` | ~1.6 GB | close to large-v3 | ~1.5-2x slower |

The speed and quality columns are estimates; measure them with `scripts/check-provider.js docker` on a real Russian call before shipping, and pick the default from those numbers.

What has to change:
- Move the model out of the `DOCKER_WHISPER` constant into `PROVIDERS.docker.transcriptionModels` and pass `settings.transcriptionModel` to `withRunningContainer`, so it becomes part of the container spec hash. Switching the model then recreates the container on the next run, the same way a thread change does now
- Memory limit per model: 2 GB is enough for `small`, but `medium` and `large-v3-turbo` need about 3-4 GB, so `--memory` has to come from the chosen model. Check that Docker Desktop's VM memory can hold it and fail with a clear message if it can't
- The progress message for the first download should name the model's size instead of the fixed "~500 MB"
- All models share the `voice-transcriber-whisper-models` volume, so switching back to one that was downloaded before costs nothing. Consider a "remove downloaded models" action, since large models take gigabytes
- Re-measure thread scaling for the bigger models: with `small`, more than 4 threads inside Docker was slower, not faster
