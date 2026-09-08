import { TranscriptSegment } from '../types';

export type TranscriptFormatId = 'srt' | 'vtt' | 'plain';

export interface TranscriptFormatSpec {
  id: TranscriptFormatId;
  label: string;
  description: string;
}

export const TRANSCRIPT_FORMATS: TranscriptFormatSpec[] = [
  {
    id: 'srt',
    label: 'SubRip (SRT)',
    description: 'Subtitle standard — YouTube, Premiere, VLC, DaVinci',
  },
  {
    id: 'vtt',
    label: 'WebVTT',
    description: 'Subtitle standard for the web — <track> elements, HTML5 players',
  },
  {
    id: 'plain',
    label: 'Plain text with timestamps',
    description: 'One [hh:mm:ss] line per phrase — for notes, docs, Slack',
  },
];

function formatClock(totalSeconds: number, millisecondSeparator: string): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const milliseconds = Math.round((clamped - Math.floor(clamped)) * 1000);
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(milliseconds).padStart(3, '0');
  return `${hh}:${mm}:${ss}${millisecondSeparator}${mmm}`;
}

function toSrt(segments: TranscriptSegment[]): string {
  return (
    segments
      .map((segment, index) =>
        [
          String(index + 1),
          `${formatClock(segment.start, ',')} --> ${formatClock(segment.end, ',')}`,
          segment.text,
        ].join('\n')
      )
      .join('\n\n') + '\n'
  );
}

function toVtt(segments: TranscriptSegment[]): string {
  const cues = segments.map(
    (segment) => `${formatClock(segment.start, '.')} --> ${formatClock(segment.end, '.')}\n${segment.text}`
  );
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function toPlainWithTimestamps(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${formatClock(segment.start, '.').slice(0, 8)}] ${segment.text}`)
    .join('\n');
}

export function formatTranscript(segments: TranscriptSegment[], format: TranscriptFormatId): string {
  if (segments.length === 0) {
    throw new Error(`Cannot build ${format}: transcription has no timestamped segments`);
  }
  switch (format) {
    case 'srt':
      return toSrt(segments);
    case 'vtt':
      return toVtt(segments);
    case 'plain':
      return toPlainWithTimestamps(segments);
  }
}
